/**
 * The `dunning` queue (B078), job side:
 *
 * - `expire` runs every 5 minutes (one schedule, one attempt: the next run redoes the work), and
 *   calls the service with the clock's time;
 * - `remind {workspaceId, day, firstFailedAt}` and `wind-down {workspaceId}` call the service;
 *   bad data (not a wsp_ id, a day other than 0, 3 or 6, no time) fails for good; unknown jobs
 *   too;
 * - the scheduler queues a reminder at its due time and a wind-down at its time (job ids per
 *   workspace and failure or drop, so each is queued once; no `:` in ids), and cancels a
 *   failure's reminders;
 * - failure path (test plan): a SessionEnder that keeps throwing fails the wind-down 5 times
 *   (exponential backoff from 10 s, jitter 0.5); after the 5th the job is copied to
 *   `dunning.dead` and `dunning_dead_letters_total{job}` counts it; earlier attempts are only
 *   logged.
 */
import { createLogger } from '@centcom/core';
import { UnrecoverableError } from 'bullmq';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createDunningScheduler,
  DUNNING_ATTEMPTS,
  DUNNING_DLQ,
  DUNNING_EXPIRE_EVERY_MS,
  DUNNING_QUEUE,
  dunningJobOptions,
  onDunningJobFailed,
  processDunningJob,
  scheduleDunningExpire,
  type DunningRunner,
} from '../src/index.js';
import { newId } from '@centcom/contracts';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function runner(over: Partial<DunningRunner> = {}) {
  const calls: unknown[][] = [];
  const r: DunningRunner = {
    expire: (now) => {
      calls.push(['expire', now]);
      return Promise.resolve({ expired: 0, announced: 0, reminders: 0 });
    },
    remind: (ws, day, firstFailedAt, now) => {
      calls.push(['remind', ws, day, firstFailedAt, now]);
      return Promise.resolve('sent');
    },
    windDown: (ws) => {
      calls.push(['wind-down', ws]);
      return Promise.resolve(2);
    },
    ...over,
  };
  return { r, calls };
}

function counting() {
  const counts = new Map<string, number>();
  return {
    counts,
    metrics: {
      counter: (name: string, labels?: Record<string, string>) => ({
        inc: (n = 1) => {
          const key = `${name}${JSON.stringify(labels ?? {})}`;
          counts.set(key, (counts.get(key) ?? 0) + n);
        },
      }),
      histogram: () => ({ observe: () => undefined }),
    },
  };
}

function captured() {
  const chunks: string[] = [];
  const logger = createLogger({
    level: 'trace',
    service: 'worker',
    version: 'test',
    destination: new Writable({
      write(chunk: Buffer, _e, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }),
  });
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('the dunning jobs', () => {
  it('runs expire, remind and wind-down through the service', async () => {
    const { r, calls } = runner();
    const ws = newId('wsp');
    const failedAt = new Date(NOW - 3 * DAY);
    const deps = { runner: r, clock: () => NOW };
    await processDunningJob({ name: 'expire', data: {} }, deps);
    await processDunningJob(
      { name: 'remind', data: { workspaceId: ws, day: 3, firstFailedAt: failedAt.toISOString() } },
      deps,
    );
    expect(await processDunningJob({ name: 'wind-down', data: { workspaceId: ws } }, deps)).toBe(2);
    expect(calls).toEqual([
      ['expire', new Date(NOW)],
      ['remind', ws, 3, failedAt, new Date(NOW)],
      ['wind-down', ws],
    ]);
  });

  it('fails for good on bad data and unknown jobs', async () => {
    const { r, calls } = runner();
    const deps = { runner: r, clock: () => NOW };
    const ws = newId('wsp');
    for (const job of [
      {
        name: 'remind',
        data: { workspaceId: 'usr_1', day: 0, firstFailedAt: new Date(NOW).toISOString() },
      },
      {
        name: 'remind',
        data: { workspaceId: ws, day: 2, firstFailedAt: new Date(NOW).toISOString() },
      },
      { name: 'remind', data: { workspaceId: ws, day: 0, firstFailedAt: 'yesterday' } },
      { name: 'remind', data: { workspaceId: ws, day: '0' } },
      { name: 'wind-down', data: {} },
      { name: 'wind-down', data: null },
      { name: 'purge', data: {} },
    ]) {
      await expect(processDunningJob(job, deps)).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(calls).toEqual([]);
  });
});

describe('the scheduler', () => {
  it('queues reminders and wind-downs at their time, once per id, and cancels reminders', async () => {
    const added: { name: string; data: unknown; opts: Record<string, unknown> }[] = [];
    const removed: string[] = [];
    const queue = {
      add: (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts });
        return Promise.resolve({} as never);
      },
      remove: (id: string) => {
        removed.push(id);
        return Promise.resolve(1);
      },
    };
    const scheduler = createDunningScheduler(queue as never, () => NOW);
    const ws = newId('wsp');
    const failedAt = new Date(NOW - DAY);
    await scheduler.remind({ workspaceId: ws, day: 0, firstFailedAt: failedAt, at: failedAt });
    await scheduler.remind({
      workspaceId: ws,
      day: 3,
      firstFailedAt: failedAt,
      at: new Date(failedAt.getTime() + 3 * DAY),
    });
    const noneAt = new Date(NOW);
    await scheduler.windDown({ workspaceId: ws, noneAt, at: new Date(NOW + 10 * 60 * 1000) });
    expect(added.map((a) => [a.name, a.data, a.opts['jobId'], a.opts['delay']])).toEqual([
      [
        'remind',
        { workspaceId: ws, day: 0, firstFailedAt: failedAt.toISOString() },
        `remind-${ws}-${failedAt.getTime()}-0`,
        0,
      ],
      [
        'remind',
        { workspaceId: ws, day: 3, firstFailedAt: failedAt.toISOString() },
        `remind-${ws}-${failedAt.getTime()}-3`,
        2 * DAY,
      ],
      ['wind-down', { workspaceId: ws }, `wind-down-${ws}-${NOW}`, 10 * 60 * 1000],
    ]);
    for (const a of added) {
      expect(a.opts).toMatchObject(dunningJobOptions());
      expect(String(a.opts['jobId'])).not.toContain(':');
    }
    await scheduler.cancelReminders(ws, failedAt);
    expect(removed).toEqual([0, 3, 6].map((d) => `remind-${ws}-${failedAt.getTime()}-${d}`));
  });

  it('runs expire every 5 minutes, one attempt a run', async () => {
    const calls: unknown[][] = [];
    await scheduleDunningExpire({
      upsertJobScheduler: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({} as never);
      },
    } as never);
    expect(calls).toEqual([
      [
        'dunning-expire-every-5-minutes',
        { every: DUNNING_EXPIRE_EVERY_MS },
        {
          name: 'expire',
          data: {},
          opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 86_400 } },
        },
      ],
    ]);
    expect(DUNNING_EXPIRE_EVERY_MS).toBe(5 * 60 * 1000);
    expect(DUNNING_QUEUE).toBe('dunning');
    expect(DUNNING_DLQ).toBe('dunning.dead');
  });
});

describe('failures', () => {
  it('dead-letters a wind-down whose SessionEnder throws 5 times, and counts it', async () => {
    expect(dunningJobOptions()).toMatchObject({
      attempts: DUNNING_ATTEMPTS,
      backoff: { type: 'exponential', delay: 10_000, jitter: 0.5 },
    });
    expect(DUNNING_ATTEMPTS).toBe(5);
    const { r } = runner({ windDown: () => Promise.reject(new Error('relay down')) });
    const ws = newId('wsp');
    const dead: { name: string; data: unknown; opts: unknown }[] = [];
    const dlq = {
      add: (name: string, data: unknown, opts: unknown) => {
        dead.push({ name, data, opts });
        return Promise.resolve({} as never);
      },
    };
    const m = counting();
    const log = captured();
    for (let attempt = 1; attempt <= DUNNING_ATTEMPTS; attempt += 1) {
      const job = {
        id: `wind-down-${ws}-${NOW}`,
        name: 'wind-down',
        data: { workspaceId: ws },
        attemptsMade: attempt,
        opts: dunningJobOptions(),
      };
      const err = await processDunningJob(job, { runner: r }).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      await onDunningJobFailed(job, err as Error, { logger: log.logger, metrics: m.metrics }, dlq);
      expect(dead).toHaveLength(attempt === DUNNING_ATTEMPTS ? 1 : 0);
    }
    expect(dead).toEqual([
      {
        name: 'wind-down',
        data: { workspaceId: ws },
        opts: expect.objectContaining({ jobId: `wind-down-${ws}-${NOW}` }),
      },
    ]);
    expect(m.counts.get('dunning_dead_letters_total{"job":"wind-down"}')).toBe(1);
    const lines = log.lines();
    expect(lines.filter((l) => l['msg'] === 'dunning.job_retry')).toHaveLength(4);
    expect(lines.find((l) => l['msg'] === 'dunning.dead_letter')).toMatchObject({
      level: 'error',
      job: 'wind-down',
      error: 'Error',
    });
    expect(JSON.stringify(lines)).not.toContain('relay down');
  });

  it('dead-letters a job with bad data at once', async () => {
    const dead: unknown[] = [];
    const m = counting();
    await onDunningJobFailed(
      { id: '7', name: 'remind', data: {}, attemptsMade: 1, opts: dunningJobOptions() },
      new UnrecoverableError('bad data'),
      { metrics: m.metrics },
      {
        add: (...args: unknown[]) => {
          dead.push(args);
          return Promise.resolve({} as never);
        },
      },
    );
    expect(dead).toHaveLength(1);
    expect(m.counts.get('dunning_dead_letters_total{"job":"remind"}')).toBe(1);
    await onDunningJobFailed(
      undefined,
      new Error('x'),
      {},
      { add: () => Promise.reject(new Error('no')) },
    );
  });
});
