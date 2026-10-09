/**
 * The `billing.seats.reconcile` queue (B073 scope "Reconciliation job billing.seats.reconcile
 * (daily)"): a run calls the API's `reconcileAll` and logs its counts; it is scheduled once a day
 * with 3 attempts and dead letters kept 7 days; a failed attempt is logged as a retry, the last one
 * counted and logged by error kind only. Then on Redis 7 (REDIS_URL, CI's integration job): one
 * scheduler however often it is upserted, a queued run reconciles, and a failing run ends in the
 * failed set after 3 attempts.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger, defineConfig, z, type MetricLabels, type Metrics } from '@centcom/core';
import { UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BILLING_SEATS_RECONCILE_ATTEMPTS,
  BILLING_SEATS_RECONCILE_EVERY_MS,
  BILLING_SEATS_RECONCILE_FAILED_RETENTION_S,
  BILLING_SEATS_RECONCILE_QUEUE,
  BILLING_SEATS_RECONCILE_SCHEDULER_ID,
  billingSeatsReconcileJobOptions,
  createBillingSeatsReconcileQueue,
  onBillingSeatsReconcileFailed,
  processBillingSeatsReconcile,
  scheduleBillingSeatsReconcile,
  startBillingSeatsReconcileWorker,
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

describe('billing.seats.reconcile', () => {
  it('runs a reconciliation and logs its counts', async () => {
    const log = captureLogger();
    let runs = 0;
    const result = await processBillingSeatsReconcile({
      run: () => {
        runs += 1;
        return Promise.resolve({ checked: 12, repaired: 2, failed: 1 });
      },
      logger: log.logger,
    });
    expect(result).toEqual({ checked: 12, repaired: 2, failed: 1 });
    expect(runs).toBe(1);
    expect(log.lines()).toEqual([
      expect.objectContaining({
        msg: 'billing.seats_reconciled',
        checked: 12,
        repaired: 2,
        failed: 1,
      }),
    ]);
    expect(BILLING_SEATS_RECONCILE_QUEUE).toBe('billing.seats.reconcile');
  });

  it('is scheduled daily with three attempts and dead letters kept 7 days', async () => {
    const calls: unknown[][] = [];
    await scheduleBillingSeatsReconcile({
      upsertJobScheduler: (...args: unknown[]) => Promise.resolve(calls.push(args)),
    } as never);
    expect(calls).toEqual([
      [
        BILLING_SEATS_RECONCILE_SCHEDULER_ID,
        { every: 24 * 60 * 60 * 1000 },
        { name: 'reconcile', opts: billingSeatsReconcileJobOptions() },
      ],
    ]);
    expect(billingSeatsReconcileJobOptions()).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000, jitter: 0.5 },
      removeOnFail: { age: 604_800 },
    });
    expect(BILLING_SEATS_RECONCILE_FAILED_RETENTION_S).toBe(604_800);
  });

  it('logs a retry, then counts and logs the dead letter, by error kind only', () => {
    const counters = countingMetrics();
    const log = captureLogger();
    const failed = (
      attemptsMade: number,
      opts: { attempts?: number } = billingSeatsReconcileJobOptions(),
    ) => ({
      id: 'repeat-1',
      attemptsMade,
      opts,
    });
    const options = { logger: log.logger, metrics: counters.metrics };
    const err = new Error('connect ECONNREFUSED db.internal:5432');
    onBillingSeatsReconcileFailed(failed(1), err, options);
    onBillingSeatsReconcileFailed(failed(2), err, options);
    expect(counters.count('billing_seat_reconcile_runs_failed_total')).toBe(0);
    onBillingSeatsReconcileFailed(failed(3), err, options);
    expect(counters.count('billing_seat_reconcile_runs_failed_total')).toBe(1);
    onBillingSeatsReconcileFailed(failed(3, {}), err, options);
    onBillingSeatsReconcileFailed(failed(1), new UnrecoverableError('bad job'), options);
    expect(counters.count('billing_seat_reconcile_runs_failed_total')).toBe(3);
    onBillingSeatsReconcileFailed(undefined, err, options);
    onBillingSeatsReconcileFailed({ id: undefined, attemptsMade: 3, opts: {} }, err, {});
    expect(counters.count('billing_seat_reconcile_runs_failed_total')).toBe(3);
    const lines = log.lines();
    expect(lines.map((l) => [l['msg'], l['level']])).toEqual([
      ['billing.seats_reconcile_retry', 'info'],
      ['billing.seats_reconcile_retry', 'info'],
      ['billing.seats_reconcile_run_failed', 'error'],
      ['billing.seats_reconcile_run_failed', 'error'],
      ['billing.seats_reconcile_run_failed', 'error'],
    ]);
    expect(lines[2]).toMatchObject({ job_id: 'repeat-1', attempts: 3, error: 'Error' });
    expect(lines[4]).toMatchObject({ attempts: 1, error: 'UnrecoverableError' });
    expect(JSON.stringify(lines)).not.toContain('db.internal');
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

describe.runIf(REDIS_URL !== undefined)('the billing.seats.reconcile queue on Redis 7', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const thing of open.splice(0)) await thing.close();
  });

  it('keeps one daily scheduler, and a queued run reconciles', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createBillingSeatsReconcileQueue({ connection, prefix });
    let runs = 0;
    const worker = startBillingSeatsReconcileWorker({
      connection,
      prefix,
      run: () => {
        runs += 1;
        return Promise.resolve({ checked: 1, repaired: 0, failed: 0 });
      },
    });
    open.push(worker, queue, { close: () => connection.quit() });
    await scheduleBillingSeatsReconcile(queue);
    await scheduleBillingSeatsReconcile(queue);
    expect(await queue.getJobSchedulersCount()).toBe(1);
    const scheduler = await queue.getJobScheduler(BILLING_SEATS_RECONCILE_SCHEDULER_ID);
    expect(scheduler?.every).toBe(BILLING_SEATS_RECONCILE_EVERY_MS);
    expect(scheduler?.template?.opts).toMatchObject({ attempts: BILLING_SEATS_RECONCILE_ATTEMPTS });
    await queue.add('reconcile', {});
    await until(() => runs >= 1);
  });

  it('tries a failing run 3 times, then leaves it dead-lettered and counted', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue = createBillingSeatsReconcileQueue({ connection, prefix });
    let runs = 0;
    const counters = countingMetrics();
    const worker = startBillingSeatsReconcileWorker({
      connection,
      prefix,
      run: () => {
        runs += 1;
        return Promise.reject(new Error('database down'));
      },
      metrics: counters.metrics,
    });
    open.push(worker, queue, { close: () => connection.quit() });
    const job = await queue.add(
      'reconcile',
      {},
      { backoff: { type: 'exponential', delay: 20, jitter: 0.5 } },
    );
    await until(async () => (await queue.getFailedCount()) === 1);
    const failed = await queue.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(3);
    expect(runs).toBe(3);
    await until(() => counters.count('billing_seat_reconcile_runs_failed_total') === 1);
  });
});
