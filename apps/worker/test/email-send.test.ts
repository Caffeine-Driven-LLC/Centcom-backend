/**
 * The `email-send` job (B032): the processor (one provider call per job even when BullMQ hands it
 * out twice: acceptance 6; permanent rejections never retried; acceptance 7's log lines), the
 * backoff (30 s base with jitter, Retry-After honoured), the dead-letter accounting, and then the
 * real thing on Redis 7 (REDIS_URL, CI's integration job): delivery through `EmailService` and a
 * BullMQ worker, idempotency end to end, 5 attempts then the dead-letter set (acceptance 5), a
 * permanent rejection failing at once, and a Retry-After wait.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createEmailService,
  createLogger,
  createMemoryRedis,
  defineConfig,
  EmailProviderError,
  emailJobOptions,
  FAILED_JOB_RETENTION_S,
  MemoryEmailProvider,
  z,
  type EmailJobData,
  type EmailProvider,
  type MetricLabels,
  type Metrics,
  type RenderedEmail,
} from '@centcom/core';
import { UnrecoverableError, type Queue, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmailQueue,
  DEFAULT_TIMEOUT_MS,
  EMAIL_BACKOFF_MAX_MS,
  emailBackoff,
  onEmailJobFailed,
  processEmailJob,
  startEmailWorker,
  type EmailJob,
} from '../src/index.js';

/** A logger whose lines are kept. */
function captureLogger() {
  const chunks: string[] = [];
  const logger = createLogger({
    level: 'trace',
    service: 'worker',
    version: 'test',
    destination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
  });
  const raw = (): string => chunks.join('');
  const lines = (): Record<string, unknown>[] =>
    raw()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, raw, lines };
}

/** A Metrics that counts counters by name and labels. */
function countingMetrics(): {
  metrics: Metrics;
  count: (name: string, labels?: MetricLabels) => number;
} {
  const counts = new Map<string, number>();
  const key = (name: string, labels?: MetricLabels): string =>
    `${name}${JSON.stringify(labels ?? {})}`;
  return {
    metrics: {
      counter: (name, labels) => ({
        inc: (n = 1) => counts.set(key(name, labels), (counts.get(key(name, labels)) ?? 0) + n),
      }),
      histogram: () => ({ observe: () => undefined }),
    },
    count: (name, labels) => counts.get(key(name, labels)) ?? 0,
  };
}

const SECRET_URL = `https://centcom.dev/i/${randomBytes(20).toString('base64url')}`;
const EMAIL: RenderedEmail = {
  to: 'ada@example.test',
  from: 'Centcom <no-reply@centcom.test>',
  subject: 'Ada invited you',
  html: `<p><a href="${SECRET_URL}">Accept</a></p>`,
  text: `Accept: ${SECRET_URL}`,
  tag: 'workspace_invite',
};
const job = (id = 'email-1', attemptsMade = 0): EmailJob => ({
  id,
  data: { template: 'workspace_invite', email: EMAIL },
  attemptsMade,
});

describe('processEmailJob', () => {
  it('sends once, remembers it, and logs only the template, job id and message id (acceptance 7)', async () => {
    const provider = new MemoryEmailProvider();
    const kv = createMemoryRedis().kv;
    const log = captureLogger();
    const counters = countingMetrics();
    const deps = { provider, kv, logger: log.logger, metrics: counters.metrics };
    expect(await processEmailJob(job(), deps)).toEqual({ providerMessageId: 'memory-1' });
    // BullMQ handing the same job out again (a stalled worker) sends nothing more (acceptance 6).
    expect(await processEmailJob(job(), deps)).toEqual({ providerMessageId: 'memory-1' });
    expect(provider.sent).toEqual([EMAIL]);
    expect(counters.count('email_sent_total', { template: 'workspace_invite' })).toBe(1);
    expect(log.lines()).toEqual([
      expect.objectContaining({
        msg: 'email.sent',
        template: 'workspace_invite',
        job_id: 'email-1',
        provider_message_id: 'memory-1',
      }),
    ]);
    for (const secret of [EMAIL.to, SECRET_URL, EMAIL.subject])
      expect(log.raw()).not.toContain(secret);
  });

  it('turns a permanent rejection into an UnrecoverableError, counted and logged without the recipient', async () => {
    const provider = new MemoryEmailProvider();
    provider.failNext = () => new EmailProviderError('rejected', { retryable: false, status: 422 });
    const log = captureLogger();
    const counters = countingMetrics();
    const deps = {
      provider,
      kv: createMemoryRedis().kv,
      logger: log.logger,
      metrics: counters.metrics,
    };
    await expect(processEmailJob(job(), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(counters.count('email_rejected_total', { template: 'workspace_invite' })).toBe(1);
    expect(log.lines()).toEqual([expect.objectContaining({ msg: 'email.rejected', status: 422 })]);
    expect(log.raw()).not.toContain(EMAIL.to);
  });

  it('rethrows retryable failures for BullMQ to retry', async () => {
    const provider = new MemoryEmailProvider();
    const failure = new EmailProviderError('unavailable', { retryable: true, status: 503 });
    provider.failNext = () => failure;
    await expect(processEmailJob(job(), { provider, kv: createMemoryRedis().kv })).rejects.toBe(
      failure,
    );
    provider.failNext = () => new Error('socket hang up');
    await expect(processEmailJob(job(), { provider, kv: createMemoryRedis().kv })).rejects.toThrow(
      'socket hang up',
    );
  });

  it('cuts a provider call off after the timeout (EMAIL_TIMEOUT_MS, 10 s by default)', async () => {
    const hanging: EmailProvider = {
      name: 'hanging',
      send: (_msg, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new EmailProviderError('timeout', { retryable: true })),
          );
        }),
    };
    const started = performance.now();
    await expect(
      processEmailJob(job(), { provider: hanging, kv: createMemoryRedis().kv, timeoutMs: 50 }),
    ).rejects.toMatchObject({
      failure: 'timeout',
      retryable: true,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it('still succeeds when the delivery cannot be remembered, counting it', async () => {
    const counters = countingMetrics();
    const kv = { ...createMemoryRedis().kv, set: () => Promise.reject(new Error('kv down')) };
    const provider = new MemoryEmailProvider();
    await processEmailJob(job(), { provider, kv, metrics: counters.metrics });
    expect(counters.count('email_unrecorded_total', { template: 'workspace_invite' })).toBe(1);
    await processEmailJob({ ...job(), id: undefined }, { provider, kv: createMemoryRedis().kv });
    expect(provider.sent).toHaveLength(2);
  });
});

describe('emailBackoff', () => {
  it('waits between half and all of 30 s · 2^(n-1), at most an hour', () => {
    const low = emailBackoff(undefined, () => 0);
    const high = emailBackoff(undefined, () => 1);
    expect([1, 2, 3, 4].map((n) => low(n))).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect([1, 2, 3, 4].map((n) => high(n))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(high(30)).toBe(EMAIL_BACKOFF_MAX_MS);
    expect(emailBackoff(10, () => 0.5)(1)).toBe(8);
  });

  it("honours the provider's Retry-After, capped at an hour", () => {
    const backoff = emailBackoff(undefined, () => 1);
    const later = new EmailProviderError('unavailable', { retryable: true, retryAfterMs: 120_000 });
    expect(backoff(1, later)).toBe(120_000);
    const tooLate = new EmailProviderError('unavailable', { retryable: true, retryAfterMs: 9e9 });
    expect(backoff(1, tooLate)).toBe(EMAIL_BACKOFF_MAX_MS);
    expect(backoff(1, new Error('other'))).toBe(30_000);
  });
});

describe('onEmailJobFailed', () => {
  const failed = (attemptsMade: number) => ({
    ...job('email-9', attemptsMade),
    opts: { attempts: 5 },
  });

  it('counts and logs a job once it is dead-lettered, not before', () => {
    const log = captureLogger();
    const counters = countingMetrics();
    const deps = { logger: log.logger, metrics: counters.metrics };
    onEmailJobFailed(failed(4), new Error('retry me'), deps);
    expect(counters.count('email_failed_total', { template: 'workspace_invite' })).toBe(0);
    onEmailJobFailed(failed(5), new Error('gave up'), deps);
    onEmailJobFailed(failed(1), new UnrecoverableError('rejected'), deps);
    onEmailJobFailed(undefined, new Error('no job'), deps);
    expect(counters.count('email_failed_total', { template: 'workspace_invite' })).toBe(2);
    expect(log.lines().map((l) => l['msg'])).toEqual([
      'email.retry',
      'email.failed',
      'email.failed',
    ]);
    expect(log.raw()).not.toContain(EMAIL.to);
    onEmailJobFailed({ ...failed(1), opts: {} }, new Error('one attempt'), {});
  });

  it('uses 5 attempts, its own backoff, and keeps dead letters for a week', () => {
    expect(emailJobOptions()).toEqual({
      attempts: 5,
      backoff: { type: 'email' },
      removeOnComplete: true,
      removeOnFail: { age: FAILED_JOB_RETENTION_S },
    });
    expect(FAILED_JOB_RETENTION_S).toBe(7 * 24 * 60 * 60);
  });
});

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

/** Resolves once `check` holds, polling; rejects after `timeoutMs`. */
async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`not within ${timeoutMs} ms`);
    await sleep(20);
  }
}

describe.runIf(REDIS_URL !== undefined)('the email-send queue on Redis 7', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    // The worker first, then the queue, then the connection they share.
    for (const thing of open.splice(0)) await thing.close();
  });

  /** A queue and a worker under a fresh prefix, delivering through `provider`. */
  function pipeline(provider: EmailProvider) {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue: Queue<EmailJobData> = createEmailQueue({ connection, prefix });
    const counters = countingMetrics();
    const memory = createMemoryRedis();
    const worker: Worker<EmailJobData> = startEmailWorker({
      connection,
      prefix,
      provider,
      kv: memory.kv,
      metrics: counters.metrics,
      backoffBaseMs: 20,
    });
    open.push(worker, queue, { close: () => connection.quit() });
    const service = createEmailService({
      queue,
      rateLimit: memory.rateLimit,
      kv: memory.kv,
      from: 'Centcom <no-reply@centcom.test>',
    });
    const invite = {
      inviterName: 'Ada',
      workspaceName: 'Engines',
      url: SECRET_URL,
      expiresAt: new Date('2026-10-14T12:00:00Z'),
    };
    return { queue, worker, counters, service, invite };
  }

  it('delivers a queued email once, also for a repeated idempotency key (acceptance 6)', async () => {
    const provider = new MemoryEmailProvider();
    const { queue, service, invite } = pipeline(provider);
    const key = randomBytes(8).toString('hex');
    const first = await service.send('workspace_invite', 'ada@example.test', invite, {
      idempotencyKey: key,
    });
    const second = await service.send('workspace_invite', 'ada@example.test', invite, {
      idempotencyKey: key,
    });
    expect(second.jobId).toBe(first.jobId);
    await until(
      async () =>
        provider.sent.length === 1 && (await queue.getJobCounts('active', 'wait')).wait === 0,
    );
    await sleep(100);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe('ada@example.test');
    // Delivered jobs leave Redis.
    await until(async () => (await queue.getJob(first.jobId)) === undefined);
  });

  it('retries 5 times, then leaves the job in the dead-letter set (acceptance 5)', async () => {
    let calls = 0;
    const flaky: EmailProvider = {
      name: 'flaky',
      send: () => {
        calls += 1;
        return Promise.reject(new EmailProviderError('timeout', { retryable: true }));
      },
    };
    const { queue, counters, service, invite } = pipeline(flaky);
    const { jobId } = await service.send('workspace_invite', 'ada@example.test', invite);
    await until(async () => (await queue.getFailedCount()) === 1);
    const dead = await queue.getJob(jobId);
    expect(dead?.attemptsMade).toBe(5);
    expect(calls).toBe(5);
    await until(
      async () => counters.count('email_failed_total', { template: 'workspace_invite' }) === 1,
    );
  });

  it('fails a permanent rejection at once, without retrying', async () => {
    let calls = 0;
    const rejecting: EmailProvider = {
      name: 'rejecting',
      send: () => {
        calls += 1;
        return Promise.reject(
          new EmailProviderError('rejected', { retryable: false, status: 422 }),
        );
      },
    };
    const { queue, counters, service, invite } = pipeline(rejecting);
    await service.send('workspace_invite', 'ada@example.test', invite);
    await until(async () => (await queue.getFailedCount()) === 1);
    expect(calls).toBe(1);
    expect(counters.count('email_rejected_total', { template: 'workspace_invite' })).toBe(1);
    await until(
      async () => counters.count('email_failed_total', { template: 'workspace_invite' }) === 1,
    );
  });

  it("waits as long as the provider's Retry-After asks", async () => {
    const attempts: number[] = [];
    const busy: EmailProvider = {
      name: 'busy',
      send: () => {
        attempts.push(performance.now());
        return attempts.length === 1
          ? Promise.reject(
              new EmailProviderError('unavailable', {
                retryable: true,
                status: 429,
                retryAfterMs: 400,
              }),
            )
          : Promise.resolve({ providerMessageId: 'busy-1' });
      },
    };
    const { service, invite } = pipeline(busy);
    await service.send('workspace_invite', 'ada@example.test', invite);
    await until(async () => attempts.length === 2);
    expect((attempts[1] ?? 0) - (attempts[0] ?? 0)).toBeGreaterThanOrEqual(380);
  });
});
