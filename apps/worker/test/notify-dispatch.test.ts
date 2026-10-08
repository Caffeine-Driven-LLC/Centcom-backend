/**
 * Notification jobs (B063, acceptance 9): `notify.dispatch` jobs carry 5 attempts with exponential
 * backoff and jitter; a job that fails every attempt is copied to `notify.dispatch.dlq` (counted,
 * logged by kind only), and a retry is only logged. `notify.digest` is scheduled hourly, once per
 * queue. On Redis 7 (REDIS_URL, CI's integration job): a dispatch that keeps failing lands in the
 * dead-letter queue after 5 attempts, and a queued digest run runs.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  defineConfig,
  NOTIFY_DIGEST_EVERY_MS,
  NOTIFY_DIGEST_QUEUE,
  NOTIFY_DISPATCH_ATTEMPTS,
  NOTIFY_DISPATCH_BACKOFF_BASE_MS,
  NOTIFY_DISPATCH_DLQ,
  NOTIFY_DISPATCH_QUEUE,
  notifyDispatchJobOptions,
  z,
  type MetricLabels,
  type Metrics,
  type NotifyDispatchJobData,
} from '@centcom/core';
import { UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNotifyDeadLetterQueue,
  createNotifyDigestQueue,
  createNotifyDispatchQueue,
  NOTIFY_DIGEST_SCHEDULER_ID,
  onNotifyDispatchFailed,
  processNotifyDispatch,
  scheduleNotifyDigest,
  startNotifyDigestWorker,
  startNotifyDispatchWorker,
  type NotifyDeadLetter,
} from '../src/index.js';

const DATA: NotifyDispatchJobData = {
  eventId: 'evt1',
  event: { category: 'trial_ending', recipients: { users: [] }, params: { days: 1 } },
  publishedAt: '2026-10-07T12:00:00.000Z',
};

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

describe('the dispatch job', () => {
  it('has 5 attempts, exponential backoff with jitter from 5 s, and failures kept a week', () => {
    expect(notifyDispatchJobOptions()).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: NOTIFY_DISPATCH_BACKOFF_BASE_MS, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    expect(NOTIFY_DISPATCH_QUEUE).toBe('notify.dispatch');
    expect(NOTIFY_DISPATCH_DLQ).toBe('notify.dispatch.dlq');
  });

  it('hands the event to the dispatcher', async () => {
    const seen: NotifyDispatchJobData[] = [];
    await processNotifyDispatch({ data: DATA }, { process: (d) => Promise.resolve(seen.push(d)) });
    expect(seen).toEqual([DATA]);
  });

  it('only logs a retry, and dead-letters the event after the last attempt', async () => {
    const added: { name: string; data: NotifyDeadLetter; opts: unknown }[] = [];
    const counters = countingMetrics();
    const deps = {
      deadLetter: {
        add: (name: string, data: NotifyDeadLetter, opts: unknown) => {
          added.push({ name, data, opts });
          return Promise.resolve({} as never);
        },
      },
      clock: () => Date.UTC(2026, 9, 7, 13),
      metrics: counters.metrics,
    };
    const job = (attemptsMade: number) => ({
      id: 'j1',
      data: DATA,
      attemptsMade,
      opts: notifyDispatchJobOptions(),
    });
    await onNotifyDispatchFailed(job(1), new Error('db down'), deps);
    await onNotifyDispatchFailed(job(4), new Error('db down'), deps);
    expect(added).toEqual([]);
    await onNotifyDispatchFailed(job(5), new TypeError('db down'), deps);
    expect(added).toEqual([
      {
        name: 'dead',
        data: { data: DATA, attempts: 5, error: 'TypeError', failedAt: '2026-10-07T13:00:00.000Z' },
        opts: expect.objectContaining({ jobId: 'dead-evt1' }),
      },
    ]);
    await onNotifyDispatchFailed(job(1), new UnrecoverableError('bad'), deps);
    expect(added).toHaveLength(2);
    expect(counters.count('notification_dispatch_failed_total')).toBe(2);
    // A dead-letter queue that cannot be written: logged, not thrown (the failed set keeps the job).
    await expect(
      onNotifyDispatchFailed(job(5), new Error('x'), {
        deadLetter: { add: () => Promise.reject(new Error('redis down')) },
      }),
    ).resolves.toBeUndefined();
    await expect(onNotifyDispatchFailed(undefined, new Error('x'), deps)).resolves.toBeUndefined();
  });
});

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`not within ${timeoutMs} ms`);
    await sleep(20);
  }
}

describe.runIf(REDIS_URL !== undefined)('notification queues on Redis 7', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const thing of open.splice(0)) await thing.close();
  });

  it('dead-letters a dispatch that fails all 5 attempts into notify.dispatch.dlq (acceptance 9)', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createNotifyDispatchQueue({ connection, prefix });
    const deadLetter = createNotifyDeadLetterQueue({ connection, prefix });
    let calls = 0;
    const worker = startNotifyDispatchWorker({
      connection,
      prefix,
      deadLetter,
      process: () => {
        calls += 1;
        return Promise.reject(new Error('database down'));
      },
    });
    open.push(worker, queue, deadLetter, { close: () => connection.quit() });
    // The queue's defaults (5 attempts), with a 20 ms backoff to keep the test fast.
    await queue.add('dispatch', DATA, {
      jobId: DATA.eventId,
      backoff: { type: 'exponential', delay: 20, jitter: 0.5 },
    });
    await until(async () => (await deadLetter.getWaitingCount()) === 1);
    expect(calls).toBe(NOTIFY_DISPATCH_ATTEMPTS);
    const [letter] = await deadLetter.getWaiting();
    expect(letter?.data).toMatchObject({ data: DATA, attempts: 5, error: 'Error' });
    expect(await queue.getFailedCount()).toBe(1);
  }, 30_000);

  it('keeps one hourly digest schedule, and a queued run runs', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createNotifyDigestQueue({ connection, prefix });
    let runs = 0;
    const worker = startNotifyDigestWorker({
      connection,
      prefix,
      run: () => {
        runs += 1;
        return Promise.resolve({ emails: 0, items: 0 });
      },
    });
    open.push(worker, queue, { close: () => connection.quit() });
    expect(queue.name).toBe(NOTIFY_DIGEST_QUEUE);
    await scheduleNotifyDigest(queue);
    await scheduleNotifyDigest(queue);
    expect(await queue.getJobSchedulersCount()).toBe(1);
    expect((await queue.getJobScheduler(NOTIFY_DIGEST_SCHEDULER_ID))?.every).toBe(
      NOTIFY_DIGEST_EVERY_MS,
    );
    await queue.add('digest', {});
    await until(() => runs >= 1);
  }, 30_000);
});
