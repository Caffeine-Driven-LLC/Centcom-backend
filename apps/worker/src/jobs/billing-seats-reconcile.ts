/**
 * The `billing.seats.reconcile` job (B073): once a day, compares every Team workspace's seats on
 * Stripe with the stored ones and the seats in use (the API's `reconcileAll` over
 * `SeatService.reconcile`, injected as `run`). A drift is repaired in the stored copy; a workspace
 * using more seats than Stripe sells is logged. One schedule per queue whatever the number of
 * workers, one run at a time. A run is idempotent (it only makes the stored seats follow Stripe),
 * so a failed run is retried, 3 attempts with backoff, then dead-lettered (kept 7 days); the next
 * day's run comes all the same.
 *
 * Owns: the schedule, the queue and the worker. Must not: change seats on Stripe.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';

/** The queue's name (card B073). */
export const BILLING_SEATS_RECONCILE_QUEUE = 'billing.seats.reconcile';
/** How often it runs: daily. */
export const BILLING_SEATS_RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;
/** The id of the repeating schedule. */
export const BILLING_SEATS_RECONCILE_SCHEDULER_ID = 'billing-seats-reconcile-daily';
/** Attempts per run, the first included. */
export const BILLING_SEATS_RECONCILE_ATTEMPTS = 3;
/** Dead-lettered runs are kept this long, in seconds (7 days). */
export const BILLING_SEATS_RECONCILE_FAILED_RETENTION_S = 7 * 24 * 60 * 60;

/** The options every run carries. */
export function billingSeatsReconcileJobOptions() {
  return {
    attempts: BILLING_SEATS_RECONCILE_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 60_000, jitter: 0.5 },
    removeOnComplete: true as const,
    removeOnFail: { age: BILLING_SEATS_RECONCILE_FAILED_RETENTION_S },
  };
}

/** What one run reports. */
export interface BillingSeatsReconcileResult {
  checked: number;
  repaired: number;
  failed: number;
}

/** What the processor needs. */
export interface BillingSeatsReconcileDeps {
  /** One run (the API's `reconcileAll`). */
  run(): Promise<BillingSeatsReconcileResult>;
  logger?: Logger;
  metrics?: Metrics;
}

/** One run, logged with its counts. */
export async function processBillingSeatsReconcile(
  deps: BillingSeatsReconcileDeps,
): Promise<BillingSeatsReconcileResult> {
  const result = await deps.run();
  deps.logger?.info({ ...result }, 'billing.seats_reconciled');
  return result;
}

/**
 * A failed attempt: logged as a retry while attempts remain; the last one (or an unrecoverable
 * error) is counted (`billing_seat_reconcile_runs_failed_total`) and logged as dead-lettered. The
 * error's kind only: its text can name the database host.
 */
export function onBillingSeatsReconcileFailed(
  job: Pick<Job, 'id' | 'attemptsMade' | 'opts'> | undefined,
  err: Error,
  deps: Pick<BillingSeatsReconcileDeps, 'logger' | 'metrics'>,
): void {
  if (job === undefined) return;
  const fields = { job_id: job.id ?? 'unknown', attempts: job.attemptsMade, error: err.name };
  const final =
    err instanceof UnrecoverableError ||
    job.attemptsMade >= (job.opts.attempts ?? BILLING_SEATS_RECONCILE_ATTEMPTS);
  if (!final) {
    deps.logger?.info(fields, 'billing.seats_reconcile_retry');
    return;
  }
  (deps.metrics ?? noopMetrics).counter('billing_seat_reconcile_runs_failed_total').inc();
  deps.logger?.error(fields, 'billing.seats_reconcile_run_failed');
}

/** Where BullMQ keeps the queue. */
export interface BillingSeatsReconcileQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

/** The `billing.seats.reconcile` queue. */
export function createBillingSeatsReconcileQueue(
  options: BillingSeatsReconcileQueueOptions,
): Queue {
  return new Queue(BILLING_SEATS_RECONCILE_QUEUE, {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    defaultJobOptions: billingSeatsReconcileJobOptions(),
  });
}

/** Makes the job run daily (idempotent: one schedule per queue). */
export async function scheduleBillingSeatsReconcile(
  queue: Pick<Queue, 'upsertJobScheduler'>,
): Promise<void> {
  await queue.upsertJobScheduler(
    BILLING_SEATS_RECONCILE_SCHEDULER_ID,
    { every: BILLING_SEATS_RECONCILE_EVERY_MS },
    { name: 'reconcile', opts: billingSeatsReconcileJobOptions() },
  );
}

/** Options for `startBillingSeatsReconcileWorker`. */
export interface BillingSeatsReconcileWorkerOptions
  extends BillingSeatsReconcileQueueOptions, BillingSeatsReconcileDeps {}

/** Starts a worker on the `billing.seats.reconcile` queue (one run at a time). */
export function startBillingSeatsReconcileWorker(
  options: BillingSeatsReconcileWorkerOptions,
): Worker {
  const worker = new Worker(
    BILLING_SEATS_RECONCILE_QUEUE,
    () => processBillingSeatsReconcile(options),
    {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      concurrency: 1,
    },
  );
  worker.on('failed', (job, err) => onBillingSeatsReconcileFailed(job, err, options));
  // Connection errors: logged by kind only (their text can name the Redis host).
  worker.on('error', (err) =>
    options.logger?.error({ error: err.name }, 'billing.seats_reconcile_worker_error'),
  );
  return worker;
}
