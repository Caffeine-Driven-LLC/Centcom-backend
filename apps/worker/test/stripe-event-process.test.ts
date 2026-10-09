/**
 * The `stripe.event.process` queue (B072, acceptance 6), job side: 8 attempts with exponential
 * backoff and jitter, the last attempt told it is the last; a job that fails its last attempt (or
 * has bad data) is copied to `stripe.event.dlq` and counted; a retry is only logged. The sweep
 * requeues events stuck for a minute, publishes the outbox, and warns when the oldest unfinished
 * event is over 10 minutes old.
 */
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  enqueueStripeEvent,
  onStripeEventFailed,
  processStripeEventJob,
  scheduleStripeEventSweep,
  STRIPE_EVENT_ATTEMPTS,
  STRIPE_EVENT_SWEEP_JOB,
  stripeEventJobOptions,
  type StripeEventDeps,
} from '../src/jobs/stripe-event-process.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function deps(over: Partial<StripeEventDeps> = {}) {
  const runs: { id: string; finalAttempt: boolean }[] = [];
  const d: StripeEventDeps = {
    process: (id, opts) => {
      runs.push({ id, ...opts });
      return Promise.resolve('processed');
    },
    waiting: () => Promise.resolve([]),
    oldestWaiting: () => Promise.resolve(null),
    publish: () => Promise.resolve(),
    clock: () => NOW,
    ...over,
  };
  return { d, runs };
}

function recordingQueue() {
  const added: { name: string; data: unknown; opts: Record<string, unknown> }[] = [];
  return {
    added,
    add: (name: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ name, data, opts });
      return Promise.resolve({} as never);
    },
    upsertJobScheduler: (id: string, repeat: unknown) => {
      added.push({ name: id, data: repeat, opts: {} });
      return Promise.resolve({} as never);
    },
  };
}

describe('stripe.event.process', () => {
  it('queues each event once with 8 attempts and jittered exponential backoff', async () => {
    const queue = recordingQueue();
    await enqueueStripeEvent(queue, 'evt_123');
    expect(queue.added).toEqual([
      {
        name: 'process',
        data: { eventId: 'evt_123' },
        opts: { ...stripeEventJobOptions(), jobId: 'evt_123' },
      },
    ]);
    expect(stripeEventJobOptions()).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
    });
  });

  it('tells the processor which attempt is the last', async () => {
    const { d, runs } = deps();
    const queue = recordingQueue();
    for (const attemptsMade of [0, 6, 7]) {
      await processStripeEventJob(
        {
          id: 'evt_1',
          name: 'process',
          data: { eventId: 'evt_1' },
          attemptsMade,
          opts: { attempts: STRIPE_EVENT_ATTEMPTS },
        },
        d,
        queue,
      );
    }
    expect(runs.map((r) => r.finalAttempt)).toEqual([false, false, true]);
    await expect(
      processStripeEventJob(
        { id: 'x', name: 'process', data: { eventId: 'nope' }, attemptsMade: 0, opts: {} },
        d,
        queue,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('dead-letters a job after its last attempt, and only then', async () => {
    const dlq = recordingQueue();
    const counts = new Map<string, number>();
    const metrics = {
      counter: (n: string) => ({ inc: () => counts.set(n, (counts.get(n) ?? 0) + 1) }),
    } as never;
    const job = {
      id: 'evt_1',
      name: 'process',
      data: { eventId: 'evt_1' },
      attemptsMade: 3,
      opts: { attempts: 8 },
    };
    await onStripeEventFailed(job, new Error('x'), { metrics }, dlq);
    expect(dlq.added).toEqual([]);
    await onStripeEventFailed({ ...job, attemptsMade: 8 }, new Error('x'), { metrics }, dlq);
    expect(dlq.added).toEqual([
      expect.objectContaining({
        name: 'dead',
        data: { eventId: 'evt_1' },
        opts: expect.objectContaining({ jobId: 'evt_1' }),
      }),
    ]);
    expect(counts.get('stripe_event_dead_letters_total')).toBe(1);
    await onStripeEventFailed(
      { ...job, attemptsMade: 1 },
      new UnrecoverableError('bad'),
      { metrics },
      dlq,
    );
    expect(dlq.added).toHaveLength(2);
    await onStripeEventFailed(undefined, new Error('x'), {}, dlq);
    await onStripeEventFailed({ ...job, name: 'sweep' }, new Error('x'), {}, dlq);
    expect(dlq.added).toHaveLength(2);
  });

  it('sweeps: requeues stuck events, publishes the outbox, warns about a stale backlog', async () => {
    const warnings: string[] = [];
    let published = 0;
    const { d } = deps({
      waiting: (before) => {
        expect(before.getTime()).toBe(NOW - 60_000);
        return Promise.resolve(['evt_a', 'evt_b']);
      },
      oldestWaiting: () => Promise.resolve(new Date(NOW - 11 * 60_000)),
      publish: () => ((published += 1), Promise.resolve()),
      logger: {
        warn: (_f: unknown, msg: string) => warnings.push(msg),
        info: () => undefined,
      } as never,
    });
    const queue = recordingQueue();
    const sweep = { id: 's', name: STRIPE_EVENT_SWEEP_JOB, data: {}, attemptsMade: 0, opts: {} };
    expect(await processStripeEventJob(sweep, d, queue)).toBe('swept');
    expect(queue.added.map((a) => a.opts['jobId'])).toEqual(['evt_a', 'evt_b']);
    expect(published).toBe(1);
    expect(warnings).toEqual(['stripe_event.backlog_stale']);
    await scheduleStripeEventSweep(queue);
    expect(queue.added.at(-1)).toMatchObject({ data: { every: 60_000 } });
  });
});
