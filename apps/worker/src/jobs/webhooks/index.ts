/**
 * Webhook jobs (B081, CT-WEBHOOKS): the API's `WebhookService` does the work (injected as `deps`);
 * these own the queues.
 *
 * - **`webhook.events`:** one job per emitted event (job id = event id). It fans the event out to
 *   endpoints, idempotently by the event id; the first attempts go on `webhook.deliver`.
 * - **`webhook.deliver`:** one job per attempt (job id = `<dlv>-<attempt>`). A failed attempt
 *   queues the next with the schedule's delay (1 m to 24 h, ±10 %). A delivery that failed its
 *   last retry is parked on `webhook.dead` for operators. A job for an attempt already made
 *   (duplicate or stale) does nothing.
 * - **`webhook.outbox`:** every 30 s, moves events written to the outbox while Redis was down onto
 *   `webhook.events`.
 *
 * Deliveries are at-least-once and unordered; receivers dedupe on `id`.
 *
 * Owns: the queues and workers. Must not: log a payload, a secret or a URL.
 */
import {
  noopMetrics,
  WEBHOOK_DEAD_QUEUE,
  WEBHOOK_DELIVER_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
  type Logger,
  type Metrics,
  type WebhookEvent,
} from '@centcom/core';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

/** The outbox drain's queue and schedule. */
export const WEBHOOK_OUTBOX_QUEUE = 'webhook.outbox';
export const WEBHOOK_OUTBOX_EVERY_MS = 30_000;
export const WEBHOOK_OUTBOX_SCHEDULER_ID = 'webhook-outbox-every-30-seconds';
/** Outbox events moved per run. */
export const WEBHOOK_OUTBOX_BATCH = 500;
/** Delivery jobs a worker runs at once (per-endpoint and per-workspace caps apply inside). */
export const WEBHOOK_DELIVER_CONCURRENCY = 50;

/** What an attempt decided (the API's `AttemptResult`). */
export interface AttemptDecision {
  skipped?: true;
  next: { attempt: number; delayMs: number } | null;
  final: 'delivered' | 'failed' | null;
}

/** What the jobs need. */
export interface WebhookJobDeps {
  fanOut(event: WebhookEvent): Promise<number>;
  attempt(deliveryId: string, attempt: number): Promise<AttemptDecision>;
  drainOutbox(
    limit: number,
    send: (events: Record<string, unknown>[]) => Promise<void>,
  ): Promise<number>;
  logger?: Logger;
  metrics?: Metrics;
}

/** The queues the jobs add to. */
export interface WebhookQueues {
  events: Pick<Queue, 'add'>;
  deliver: Pick<Queue, 'add'>;
  dead: Pick<Queue, 'add'>;
}

const jobOptions = { removeOnComplete: true, removeOnFail: { age: 7 * 24 * 60 * 60 } } as const;

/** One `webhook.deliver` job: the attempt, then the next one or the dead letter. */
export async function processWebhookAttempt(
  data: { deliveryId: string; attempt: number },
  deps: WebhookJobDeps,
  queues: Pick<WebhookQueues, 'deliver' | 'dead'>,
  now: () => number = Date.now,
): Promise<AttemptDecision> {
  const decision = await deps.attempt(data.deliveryId, data.attempt);
  if (decision.next !== null) {
    const same = decision.next.attempt === data.attempt;
    await queues.deliver.add(
      'attempt',
      { deliveryId: data.deliveryId, attempt: decision.next.attempt },
      {
        ...jobOptions,
        delay: decision.next.delayMs,
        // A paused attempt (its secret could not be opened) waits under a new id.
        jobId: same
          ? `${data.deliveryId}-${data.attempt}-wait-${now()}`
          : `${data.deliveryId}-${decision.next.attempt}`,
      },
    );
  }
  if (decision.final === 'failed') {
    await queues.dead.add(
      'dead',
      { deliveryId: data.deliveryId },
      { ...jobOptions, jobId: data.deliveryId },
    );
    (deps.metrics ?? noopMetrics).counter('webhook_deliveries_dead_total').inc();
  }
  return decision;
}

/** One outbox drain: moves waiting events onto `webhook.events`. */
export async function processWebhookOutbox(
  deps: WebhookJobDeps,
  queues: Pick<WebhookQueues, 'events'>,
): Promise<number> {
  const moved = await deps.drainOutbox(WEBHOOK_OUTBOX_BATCH, async (events) => {
    for (const event of events) {
      const id = String(event['id'] ?? '');
      await queues.events.add('event', event, { ...jobOptions, jobId: id });
    }
  });
  if (moved > 0) deps.logger?.info({ moved }, 'webhook.outbox_drained');
  return moved;
}

/** Where BullMQ keeps the queues. */
export interface WebhookQueueOptions {
  connection: ConnectionOptions;
  /** BullMQ's key prefix; default `bull`. */
  prefix?: string;
}

const queueOf = (name: string, o: WebhookQueueOptions): Queue =>
  new Queue(name, {
    connection: o.connection,
    ...(o.prefix === undefined ? {} : { prefix: o.prefix }),
    defaultJobOptions: jobOptions,
  });

/** The four queues. */
export function createWebhookQueues(o: WebhookQueueOptions): WebhookQueues & { outbox: Queue } {
  return {
    events: queueOf(WEBHOOK_EVENTS_QUEUE, o),
    deliver: queueOf(WEBHOOK_DELIVER_QUEUE, o),
    dead: queueOf(WEBHOOK_DEAD_QUEUE, o),
    outbox: queueOf(WEBHOOK_OUTBOX_QUEUE, o),
  };
}

/** Makes the outbox drain run every 30 s (one schedule per queue). */
export async function scheduleWebhookOutbox(
  queue: Pick<Queue, 'upsertJobScheduler'>,
): Promise<void> {
  await queue.upsertJobScheduler(
    WEBHOOK_OUTBOX_SCHEDULER_ID,
    { every: WEBHOOK_OUTBOX_EVERY_MS },
    { name: 'drain', opts: jobOptions },
  );
}

/** Starts the three workers; close them with `worker.close()`. */
export function startWebhookWorkers(
  o: WebhookQueueOptions,
  deps: WebhookJobDeps,
  queues: WebhookQueues,
): Worker[] {
  const connection = {
    connection: o.connection,
    ...(o.prefix === undefined ? {} : { prefix: o.prefix }),
  };
  const failed = (name: string) => (job: { id?: string } | undefined, err: Error) => {
    (deps.metrics ?? noopMetrics).counter('webhook_jobs_failed_total', { queue: name }).inc();
    deps.logger?.warn(
      { job_id: job?.id ?? 'unknown', queue: name, error: err.name },
      'webhook.job_failed',
    );
  };
  const events = new Worker<WebhookEvent>(WEBHOOK_EVENTS_QUEUE, (job) => deps.fanOut(job.data), {
    ...connection,
    concurrency: 10,
  });
  const deliver = new Worker<{ deliveryId: string; attempt: number }>(
    WEBHOOK_DELIVER_QUEUE,
    (job) => processWebhookAttempt(job.data, deps, queues),
    { ...connection, concurrency: WEBHOOK_DELIVER_CONCURRENCY },
  );
  const outbox = new Worker(WEBHOOK_OUTBOX_QUEUE, () => processWebhookOutbox(deps, queues), {
    ...connection,
    concurrency: 1,
  });
  events.on('failed', failed(WEBHOOK_EVENTS_QUEUE));
  deliver.on('failed', failed(WEBHOOK_DELIVER_QUEUE));
  outbox.on('failed', failed(WEBHOOK_OUTBOX_QUEUE));
  return [events, deliver, outbox];
}
