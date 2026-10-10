/**
 * The `quota-signals` queue (B076 interfaces "BullMQ queue quota-signals with jobs evaluate
 * {workspaceId} and sweep {}; attempts 5, exponential backoff 2 s with jitter, DLQ queue
 * quota-signals:dead"; test plan "failure-path: ... DLQ after 5 failures"), and the
 * `quota:state:{wsp}` hash on Redis:
 *
 * - `evaluate` calls the API's evaluation with the workspace; `sweep` the sweep; a bad workspace
 *   id or an unknown job is not retried;
 * - an evaluation is queued under the workspace's job id with the debounce delay; the sweep is
 *   scheduled every 60 s; 5 attempts, backoff from 2 s with jitter;
 * - a failed attempt is logged as a retry; the last one is counted, logged by error kind only and
 *   copied to `quota-signals.dead` (BullMQ refuses `:` in a queue name);
 * Then on Redis 7 (REDIS_URL, CI's integration job):
 * - two updates within the debounce make one waiting evaluation, which runs once;
 * - an evaluation failing every time runs 5 times, lands in the dead-letter queue, and frees the
 *   workspace's job id for the next trigger;
 * - the hash: written whole (stale fields gone), read back, expiring at the given instant, dropped;
 *   values other than ok, warn or reached ignored; `fill` writes it (with its expiry, under the
 *   client's key prefix) only when it does not exist.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createLogger,
  defineConfig,
  Secret,
  z,
  type MetricLabels,
  type Metrics,
} from '@centcom/core';
import { UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createQuotaSignalsDeadQueue,
  createQuotaSignalsQueue,
  createQuotaStateRedisClient,
  createRedisQuotaStateCache,
  enqueueQuotaEvaluate,
  evaluateJobId,
  onQuotaSignalsFailed,
  processQuotaSignals,
  QUOTA_EVAL_DEBOUNCE_MS,
  QUOTA_SIGNALS_ATTEMPTS,
  QUOTA_SIGNALS_DEAD_QUEUE,
  QUOTA_SIGNALS_QUEUE,
  QUOTA_SWEEP_SCHEDULER_ID,
  quotaSignalsJobOptions,
  quotaStateRedisKey,
  scheduleQuotaSweep,
  startQuotaSignalsWorker,
} from '../src/index.js';

const WS = 'wsp_01J9Z8X7W6V5T4S3R2Q1P0NMKH';

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
  const lines = (): Record<string, unknown>[] =>
    chunks
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines };
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

describe('quota-signals jobs', () => {
  it('evaluates the workspace and sweeps; refuses bad jobs without retrying', async () => {
    const calls: string[] = [];
    const deps = {
      evaluate: (ws: string) => {
        calls.push(`evaluate ${ws}`);
        return Promise.resolve([]);
      },
      sweep: () => {
        calls.push('sweep');
        return Promise.resolve(3);
      },
    };
    await processQuotaSignals({ name: 'evaluate', data: { workspaceId: WS } }, deps);
    expect(await processQuotaSignals({ name: 'sweep', data: {} }, deps)).toEqual({ queued: 3 });
    expect(calls).toEqual([`evaluate ${WS}`, 'sweep']);
    for (const job of [
      { name: 'evaluate', data: { workspaceId: 'wsp_bad' } },
      { name: 'evaluate', data: null },
      { name: 'purge', data: {} },
    ]) {
      await expect(processQuotaSignals(job, deps)).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(calls).toHaveLength(2);
    expect(QUOTA_SIGNALS_QUEUE).toBe('quota-signals');
    expect(QUOTA_SIGNALS_DEAD_QUEUE).toBe('quota-signals.dead');
  });

  it('queues an evaluation under the workspace id after the debounce, and schedules the sweep', async () => {
    const adds: unknown[][] = [];
    const queue = { add: (...args: unknown[]) => Promise.resolve(adds.push(args)) } as never;
    await enqueueQuotaEvaluate(queue, WS);
    await enqueueQuotaEvaluate(queue, WS, 0);
    await expect(enqueueQuotaEvaluate(queue, 'wsp_x')).rejects.toThrow(TypeError);
    expect(adds).toEqual([
      [
        'evaluate',
        { workspaceId: WS },
        { ...quotaSignalsJobOptions(), jobId: `evaluate-${WS}`, delay: 10_000 },
      ],
      [
        'evaluate',
        { workspaceId: WS },
        { ...quotaSignalsJobOptions(), jobId: `evaluate-${WS}`, delay: 0 },
      ],
    ]);
    expect(evaluateJobId(WS)).not.toContain(':');
    expect(QUOTA_EVAL_DEBOUNCE_MS).toBe(10_000);

    const scheduled: unknown[][] = [];
    await scheduleQuotaSweep({
      upsertJobScheduler: (...args: unknown[]) => Promise.resolve(scheduled.push(args)),
    } as never);
    expect(scheduled).toEqual([
      [
        QUOTA_SWEEP_SCHEDULER_ID,
        { every: 60_000 },
        { name: 'sweep', data: {}, opts: quotaSignalsJobOptions() },
      ],
    ]);
    expect(quotaSignalsJobOptions()).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('logs retries, then counts, logs and dead-letters the last failure', async () => {
    const counters = countingMetrics();
    const log = captureLogger();
    const letters: unknown[][] = [];
    const deadLetter = {
      add: (...args: unknown[]) => Promise.resolve(letters.push(args)),
    } as never;
    const job = (attemptsMade: number) => ({
      id: `evaluate-${WS}`,
      name: 'evaluate',
      data: { workspaceId: WS },
      attemptsMade,
      opts: quotaSignalsJobOptions(),
      timestamp: 1_760_000_000_000,
    });
    const err = new Error('connect ECONNREFUSED db.internal:5432');
    const deps = { logger: log.logger, metrics: counters.metrics, deadLetter };
    await onQuotaSignalsFailed(job(1), err, deps);
    await onQuotaSignalsFailed(job(4), err, deps);
    expect(letters).toEqual([]);
    await onQuotaSignalsFailed(job(5), err, deps);
    await onQuotaSignalsFailed(
      { ...job(1), id: 'repeat:quota-signals-sweep:1', name: 'sweep', data: {} },
      new UnrecoverableError('bad'),
      deps,
    );
    await onQuotaSignalsFailed(undefined, err, deps);
    expect(counters.count('quota_signal_jobs_failed_total', { job: 'evaluate' })).toBe(1);
    expect(counters.count('quota_signal_jobs_failed_total', { job: 'sweep' })).toBe(1);
    expect(letters).toEqual([
      [
        'dead',
        { name: 'evaluate', data: { workspaceId: WS }, attempts: 5, error: 'Error' },
        expect.objectContaining({ jobId: `dead-evaluate-${WS}-1760000000000` }),
      ],
      [
        'dead',
        expect.objectContaining({ name: 'sweep', error: 'UnrecoverableError' }),
        expect.objectContaining({ jobId: 'dead-repeat-quota-signals-sweep-1-1760000000000' }),
      ],
    ]);
    expect(log.lines().map((l) => l['msg'])).toEqual([
      'quota.job_retry',
      'quota.job_retry',
      'quota.job_failed',
      'quota.job_failed',
    ]);
    expect(JSON.stringify(log.lines())).not.toContain('db.internal');

    // A dead-letter queue that fails is logged, never thrown.
    await onQuotaSignalsFailed(job(5), err, {
      ...deps,
      deadLetter: { add: () => Promise.reject(new Error('down')) } as never,
    });
    expect(log.lines().at(-1)).toMatchObject({ msg: 'quota.dead_letter_failed' });
  });

  it('refuses a hash client without the deployment prefix', () => {
    expect(() =>
      createQuotaStateRedisClient({ url: new Secret('redis://127.0.0.1:1'), keyPrefix: 'quota:' }),
    ).toThrow(TypeError);
  });
});

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

/** Resolves once `check` holds, polling; rejects after `timeoutMs`. */
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`not within ${timeoutMs} ms`);
    await sleep(20);
  }
}

describe.runIf(REDIS_URL !== undefined)('quota signals on Redis 7', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const thing of open.splice(0)) await thing.close();
  });

  it('makes one evaluation of two updates within the debounce', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createQuotaSignalsQueue({ connection, prefix });
    const dead = createQuotaSignalsDeadQueue({ connection, prefix });
    const runs: string[] = [];
    const worker = startQuotaSignalsWorker({
      connection,
      prefix,
      deadLetter: dead,
      evaluate: (ws) => {
        runs.push(ws);
        return Promise.resolve([]);
      },
      sweep: () => Promise.resolve(0),
    });
    open.push(worker, queue, dead, { close: () => connection.quit() });
    // 2 s: both adds and the count finish well inside it, even on a loaded runner.
    await enqueueQuotaEvaluate(queue, WS, 2000);
    await enqueueQuotaEvaluate(queue, WS, 2000);
    expect(await queue.getDelayedCount()).toBe(1);
    await until(() => runs.length >= 1);
    await sleep(500);
    expect(runs).toEqual([WS]);
    // Done and removed: the next update queues again.
    await enqueueQuotaEvaluate(queue, WS, 0);
    await until(() => runs.length >= 2);

    await scheduleQuotaSweep(queue);
    await scheduleQuotaSweep(queue);
    expect(await queue.getJobSchedulersCount()).toBe(1);
  }, 20_000);

  it('dead-letters an evaluation after 5 attempts and frees the workspace’s job id', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createQuotaSignalsQueue({ connection, prefix });
    const dead = createQuotaSignalsDeadQueue({ connection, prefix });
    let attempts = 0;
    let failing = true;
    const counters = countingMetrics();
    const worker = startQuotaSignalsWorker({
      connection,
      prefix,
      deadLetter: dead,
      evaluate: () => {
        attempts += 1;
        return failing ? Promise.reject(new Error('redis down')) : Promise.resolve([]);
      },
      sweep: () => Promise.resolve(0),
      metrics: counters.metrics,
    });
    open.push(worker, queue, dead, { close: () => connection.quit() });
    await queue.add(
      'evaluate',
      { workspaceId: WS },
      {
        ...quotaSignalsJobOptions(),
        jobId: evaluateJobId(WS),
        backoff: { type: 'exponential', delay: 20, jitter: 0.5 },
      },
    );
    await until(async () => (await dead.getJobCounts('waiting'))['waiting'] === 1);
    expect(attempts).toBe(QUOTA_SIGNALS_ATTEMPTS);
    expect(await queue.getJob(evaluateJobId(WS))).toBeUndefined();
    expect(counters.count('quota_signal_jobs_failed_total', { job: 'evaluate' })).toBe(1);
    const [letter] = await dead.getJobs(['waiting']);
    expect(letter?.data).toEqual({
      name: 'evaluate',
      data: { workspaceId: WS },
      attempts: 5,
      error: 'Error',
    });
    failing = false;
    await enqueueQuotaEvaluate(queue, WS, 0);
    await until(() => attempts === QUOTA_SIGNALS_ATTEMPTS + 1);
  });

  it('writes the hash whole, reads it back, expires it and drops it', async () => {
    const keyPrefix = `ct:t${randomBytes(4).toString('hex')}:`;
    const client = createQuotaStateRedisClient({ url: new Secret(REDIS_URL ?? ''), keyPrefix });
    const raw = new Redis(REDIS_URL ?? '');
    open.push({ close: () => client.quit() }, { close: () => raw.quit() });
    const cache = createRedisQuotaStateCache(client);
    const key = `${keyPrefix}${quotaStateRedisKey(WS)}`;
    expect(key).toBe(`${keyPrefix}quota:state:${WS}`);

    await raw.hset(key, { stale: 'x', queue_items_month: 'warn' });
    const expiresAt = new Date(Date.now() + 60_000);
    await cache.write(WS, { hosted_minutes_month: 'reached', queue_items_month: 'ok' }, expiresAt);
    expect(await raw.hgetall(key)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
    expect(Math.abs((await raw.pexpiretime(key)) - expiresAt.getTime())).toBeLessThan(5);
    expect(await cache.read(WS)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });

    await raw.hset(key, { queue_items_month: 'bogus' });
    expect(await cache.read(WS)).toEqual({ hosted_minutes_month: 'reached' });
    await cache.drop(WS);
    expect(await cache.read(WS)).toBeNull();

    await cache.write(
      WS,
      { hosted_minutes_month: 'warn', queue_items_month: 'ok' },
      new Date(Date.now() + 150),
    );
    await sleep(400);
    expect(await cache.read(WS)).toBeNull();

    // fill: only when there is no hash.
    const fillExpiry = new Date(Date.now() + 60_000);
    expect(
      await cache.fill(WS, { hosted_minutes_month: 'warn', queue_items_month: 'ok' }, fillExpiry),
    ).toBe(true);
    expect(await raw.hgetall(key)).toEqual({
      hosted_minutes_month: 'warn',
      queue_items_month: 'ok',
    });
    expect(Math.abs((await raw.pexpiretime(key)) - fillExpiry.getTime())).toBeLessThan(5);
    await cache.write(WS, { hosted_minutes_month: 'reached', queue_items_month: 'ok' }, fillExpiry);
    expect(
      await cache.fill(WS, { hosted_minutes_month: 'ok', queue_items_month: 'ok' }, fillExpiry),
    ).toBe(false);
    expect(await cache.read(WS)).toEqual({
      hosted_minutes_month: 'reached',
      queue_items_month: 'ok',
    });
    await cache.drop(WS);
  });
});
