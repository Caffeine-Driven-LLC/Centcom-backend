/**
 * Webhook jobs (B081): a delivery attempt queues its successor with the schedule's delay under
 * `<dlv>-<attempt>`, parks a delivery that failed its last retry on `webhook.dead`, and re-queues a
 * paused attempt (secret unavailable) under a new id; the outbox drain moves events onto
 * `webhook.events` with the event id as job id; the drain runs every 30 s.
 */
import { describe, expect, it } from 'vitest';
import {
  processWebhookAttempt,
  processWebhookOutbox,
  scheduleWebhookOutbox,
  WEBHOOK_OUTBOX_EVERY_MS,
  type AttemptDecision,
  type WebhookJobDeps,
} from '../src/jobs/webhooks/index.js';

const DLV = 'dlv_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

function deps(decision: AttemptDecision, outbox: Record<string, unknown>[] = []): WebhookJobDeps {
  return {
    fanOut: () => Promise.resolve(0),
    attempt: () => Promise.resolve(decision),
    drainOutbox: async (limit, send) => {
      const batch = outbox.splice(0, limit);
      if (batch.length > 0) await send(batch);
      return batch.length;
    },
  };
}

function queues() {
  const added: { queue: string; name: string; data: unknown; opts: Record<string, unknown> }[] = [];
  const queue = (name: string) => ({
    add: (job: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ queue: name, name: job, data, opts });
      return Promise.resolve();
    },
  });
  return {
    added,
    deliver: queue('deliver') as never,
    dead: queue('dead') as never,
    events: queue('events') as never,
  };
}

describe('webhook jobs', () => {
  it('queues the next attempt with its delay under <dlv>-<attempt>', async () => {
    const q = queues();
    await processWebhookAttempt(
      { deliveryId: DLV, attempt: 1 },
      deps({ next: { attempt: 2, delayMs: 60_000 }, final: null }),
      q,
    );
    expect(q.added).toEqual([
      expect.objectContaining({
        queue: 'deliver',
        data: { deliveryId: DLV, attempt: 2 },
        opts: expect.objectContaining({ jobId: `${DLV}-2`, delay: 60_000 }),
      }),
    ]);
  });

  it('parks a delivery that failed its last retry on webhook.dead', async () => {
    const q = queues();
    await processWebhookAttempt(
      { deliveryId: DLV, attempt: 8 },
      deps({ next: null, final: 'failed' }),
      q,
    );
    expect(q.added).toEqual([
      expect.objectContaining({
        queue: 'dead',
        data: { deliveryId: DLV },
        opts: expect.objectContaining({ jobId: DLV }),
      }),
    ]);
  });

  it('adds nothing after a delivered or skipped attempt, and re-queues a paused one under a new id', async () => {
    const q = queues();
    await processWebhookAttempt(
      { deliveryId: DLV, attempt: 1 },
      deps({ next: null, final: 'delivered' }),
      q,
    );
    await processWebhookAttempt(
      { deliveryId: DLV, attempt: 3 },
      deps({ skipped: true, next: null, final: null }),
      q,
    );
    expect(q.added).toEqual([]);
    await processWebhookAttempt(
      { deliveryId: DLV, attempt: 3 },
      deps({ next: { attempt: 3, delayMs: 60_000 }, final: null }),
      q,
      () => 42,
    );
    expect(q.added[0]?.opts).toMatchObject({ jobId: `${DLV}-3-wait-42`, delay: 60_000 });
  });

  it('drains the outbox onto webhook.events under each event id, every 30 s', async () => {
    const q = queues();
    const events = [
      { id: 'e1', type: 'usage.threshold' },
      { id: 'e2', type: 'usage.threshold' },
    ];
    expect(await processWebhookOutbox(deps({ next: null, final: null }, events), q)).toBe(2);
    expect(q.added.map((a) => [a.queue, a.opts['jobId']])).toEqual([
      ['events', 'e1'],
      ['events', 'e2'],
    ]);
    const scheduled: unknown[][] = [];
    await scheduleWebhookOutbox({
      upsertJobScheduler: (...args: unknown[]) => Promise.resolve(void scheduled.push(args)),
    } as never);
    expect(scheduled[0]?.[1]).toEqual({ every: WEBHOOK_OUTBOX_EVERY_MS });
    expect(WEBHOOK_OUTBOX_EVERY_MS).toBe(30_000);
  });
});
