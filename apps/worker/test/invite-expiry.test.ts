/**
 * The `invite-expiry` job and the invites purge hook (B029 acceptance 6 and 7): a run sweeps at the
 * current time and reports counts only; the job repeats every 5 minutes under one scheduler,
 * however often it is scheduled, so a key bundle outlives its invite (or its 15 minutes after
 * acceptance) by 5 minutes at most. A failing run is tried 3 times in all, backing off with
 * jitter, then is dead-lettered (GUIDELINES §6.2). The purge hook deletes a purged workspace's invites
 * before B027's purge removes the row. Then on Redis 7 (REDIS_URL, CI's integration job): one
 * scheduler every 5 minutes carrying the retry options, a queued run sweeps, and a run that keeps
 * failing ends in the failed set after 3 attempts.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { newId } from '@centcom/contracts';
import { createLogger, defineConfig, z, type MetricLabels, type Metrics } from '@centcom/core';
import { UnrecoverableError, type Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInviteExpiryQueue,
  createPurgeHookRegistry,
  INVITE_EXPIRY_ATTEMPTS,
  INVITE_EXPIRY_BACKOFF_BASE_MS,
  INVITE_EXPIRY_EVERY_MS,
  INVITE_EXPIRY_FAILED_RETENTION_S,
  INVITE_EXPIRY_QUEUE,
  INVITE_EXPIRY_SCHEDULER_ID,
  INVITE_PURGE_HOOK,
  inviteExpiryJobOptions,
  onInviteExpiryFailed,
  processInviteExpiry,
  processWorkspacePurge,
  registerInvitePurgeHook,
  scheduleInviteExpiry,
  startInviteExpiryWorker,
} from '../src/index.js';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

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

/** A store that records its sweeps and answers `result`. */
function sweepingStore(result = { expired: 0, bundlesDropped: 0 }) {
  const sweeps: Date[] = [];
  return {
    sweeps,
    sweep(now: Date) {
      sweeps.push(now);
      return Promise.resolve(result);
    },
  };
}

describe('processInviteExpiry', () => {
  it('sweeps at the current time, counts what it did and logs counts only', async () => {
    const store = sweepingStore({ expired: 3, bundlesDropped: 2 });
    const counters = countingMetrics();
    const log = captureLogger();
    const result = await processInviteExpiry({
      store,
      clock: () => NOW,
      logger: log.logger,
      metrics: counters.metrics,
    });
    expect(result).toEqual({ expired: 3, bundlesDropped: 2 });
    expect(store.sweeps).toEqual([new Date(NOW)]);
    expect(counters.count('invites_expired_total')).toBe(3);
    expect(counters.count('invite_key_bundles_dropped_total')).toBe(2);
    expect(log.lines()).toEqual([
      expect.objectContaining({ msg: 'invite.expiry_swept', expired: 3, bundles_dropped: 2 }),
    ]);
  });

  it('counts nothing when there was nothing to do, and fails when the store does', async () => {
    const counters = countingMetrics();
    await processInviteExpiry({ store: sweepingStore(), metrics: counters.metrics });
    expect(counters.count('invites_expired_total')).toBe(0);
    expect(counters.count('invite_key_bundles_dropped_total')).toBe(0);
    const failing = { sweep: () => Promise.reject(new Error('database down')) };
    await expect(processInviteExpiry({ store: failing })).rejects.toThrow('database down');
  });

  it('defaults to the real clock', async () => {
    const store = sweepingStore();
    const before = Date.now();
    await processInviteExpiry({ store });
    expect(store.sweeps[0]?.getTime()).toBeGreaterThanOrEqual(before);
    expect(store.sweeps[0]?.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('scheduleInviteExpiry', () => {
  it('upserts one scheduler that runs every 5 minutes', async () => {
    const calls: unknown[][] = [];
    const queue = {
      upsertJobScheduler: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    } as unknown as Queue;
    await scheduleInviteExpiry(queue);
    await scheduleInviteExpiry(queue);
    expect(INVITE_EXPIRY_EVERY_MS).toBe(5 * 60 * 1000);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]).toBe(INVITE_EXPIRY_SCHEDULER_ID);
      expect(call[1]).toEqual({ every: 5 * 60 * 1000 });
      // Scheduled runs retry and dead-letter like any other.
      expect(call[2]).toEqual({ name: 'sweep', opts: inviteExpiryJobOptions() });
    }
  });
});

describe('retries', () => {
  it('are 3 attempts, backing off from 10 s with jitter, with dead letters kept for a week', () => {
    expect(inviteExpiryJobOptions()).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    expect(INVITE_EXPIRY_ATTEMPTS).toBe(3);
    expect(INVITE_EXPIRY_BACKOFF_BASE_MS).toBe(10_000);
    expect(INVITE_EXPIRY_FAILED_RETENTION_S).toBe(7 * 24 * 60 * 60);
  });

  it('log a retry, then count and log the dead letter, by error kind only', () => {
    const counters = countingMetrics();
    const log = captureLogger();
    const failed = (
      attemptsMade: number,
      opts: { attempts?: number } = inviteExpiryJobOptions(),
    ) => ({
      id: 'repeat-1',
      attemptsMade,
      opts,
    });
    const options = { logger: log.logger, metrics: counters.metrics };
    const err = new Error('connect ECONNREFUSED db.internal:5432');
    onInviteExpiryFailed(failed(1), err, options);
    onInviteExpiryFailed(failed(2), err, options);
    expect(counters.count('invite_expiry_failed_total')).toBe(0);
    onInviteExpiryFailed(failed(3), err, options);
    expect(counters.count('invite_expiry_failed_total')).toBe(1);
    // A job without `attempts` falls back to 3; an UnrecoverableError is final at once.
    onInviteExpiryFailed(failed(2, {}), err, options);
    onInviteExpiryFailed(failed(3, {}), err, options);
    expect(counters.count('invite_expiry_failed_total')).toBe(2);
    onInviteExpiryFailed(failed(1), new UnrecoverableError('bad job'), options);
    expect(counters.count('invite_expiry_failed_total')).toBe(3);
    // No job: nothing to say. No id: `unknown`. No logger or metrics: silent.
    onInviteExpiryFailed(undefined, err, options);
    onInviteExpiryFailed({ id: undefined, attemptsMade: 1, opts: {} }, err, options);
    onInviteExpiryFailed(failed(3), err, {});
    expect(counters.count('invite_expiry_failed_total')).toBe(3);
    const lines = log.lines();
    expect(lines.map((l) => [l['msg'], l['level']])).toEqual([
      ['invite.expiry_retry', 'info'],
      ['invite.expiry_retry', 'info'],
      ['invite.expiry_failed', 'error'],
      ['invite.expiry_retry', 'info'],
      ['invite.expiry_failed', 'error'],
      ['invite.expiry_failed', 'error'],
      ['invite.expiry_retry', 'info'],
    ]);
    expect(lines[2]).toMatchObject({ job_id: 'repeat-1', attempts: 3, error: 'Error' });
    expect(lines[5]).toMatchObject({ attempts: 1, error: 'UnrecoverableError' });
    expect(lines[6]).toMatchObject({ job_id: 'unknown', attempts: 1 });
    expect(JSON.stringify(lines)).not.toContain('db.internal');
  });
});

describe('the invites purge hook', () => {
  it('deletes a purged workspace’s invites before the workspace row goes', async () => {
    const steps: string[] = [];
    const hooks = createPurgeHookRegistry();
    registerInvitePurgeHook(hooks, {
      deleteForWorkspace: (workspaceId) => {
        steps.push(`invites:${workspaceId}`);
        return Promise.resolve(2);
      },
    });
    expect(hooks.list().map((h) => h.name)).toEqual([INVITE_PURGE_HOOK]);
    const workspaceId = newId('wsp');
    await processWorkspacePurge(
      { id: `purge-${workspaceId}`, data: { workspaceId }, attemptsMade: 0 },
      {
        hooks,
        store: {
          purge: (id) => {
            steps.push(`purge:${id}`);
            return Promise.resolve({ purged: true });
          },
        },
        events: { publish: () => Promise.resolve() },
        clock: () => NOW,
      },
    );
    expect(steps).toEqual([`invites:${workspaceId}`, `purge:${workspaceId}`]);
    // Registered once only.
    expect(() =>
      registerInvitePurgeHook(hooks, { deleteForWorkspace: () => Promise.resolve(0) }),
    ).toThrow(TypeError);
  });
});

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

/** Resolves once `check` holds, polling; rejects after `timeoutMs`. */
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`not within ${timeoutMs} ms`);
    await sleep(20);
  }
}

describe.runIf(REDIS_URL !== undefined)('the invite-expiry queue on Redis 7', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const thing of open.splice(0)) await thing.close();
  });

  it('keeps one scheduler every 5 minutes, and a queued run sweeps', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createInviteExpiryQueue({ connection, prefix });
    const store = sweepingStore({ expired: 1, bundlesDropped: 0 });
    const worker = startInviteExpiryWorker({ connection, prefix, store });
    open.push(worker, queue, { close: () => connection.quit() });
    expect(queue.name).toBe(INVITE_EXPIRY_QUEUE);
    await scheduleInviteExpiry(queue);
    await scheduleInviteExpiry(queue);
    expect(await queue.getJobSchedulersCount()).toBe(1);
    const scheduler = await queue.getJobScheduler(INVITE_EXPIRY_SCHEDULER_ID);
    expect(scheduler?.every).toBe(INVITE_EXPIRY_EVERY_MS);
    expect(scheduler?.template?.opts).toMatchObject({
      attempts: INVITE_EXPIRY_ATTEMPTS,
      backoff: { type: 'exponential', delay: INVITE_EXPIRY_BACKOFF_BASE_MS, jitter: 0.5 },
    });
    await queue.add('sweep', {});
    await until(() => store.sweeps.length >= 1);
  });

  it('tries a failing sweep 3 times, then leaves the run dead-lettered', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createInviteExpiryQueue({ connection, prefix });
    let sweeps = 0;
    const store = {
      sweep: () => {
        sweeps += 1;
        return Promise.reject(new Error('database down'));
      },
    };
    const counters = countingMetrics();
    const worker = startInviteExpiryWorker({
      connection,
      prefix,
      store,
      metrics: counters.metrics,
    });
    open.push(worker, queue, { close: () => connection.quit() });
    // The queue's defaults (3 attempts), with a 20 ms backoff to keep the test fast.
    const job = await queue.add(
      'sweep',
      {},
      { backoff: { type: 'exponential', delay: 20, jitter: 0.5 } },
    );
    await until(async () => (await queue.getFailedCount()) === 1);
    const failed = await queue.getJob(job.id ?? '');
    expect(failed?.opts.attempts).toBe(INVITE_EXPIRY_ATTEMPTS);
    expect(failed?.attemptsMade).toBe(3);
    expect(sweeps).toBe(3);
    await until(() => counters.count('invite_expiry_failed_total') === 1);
  });
});
