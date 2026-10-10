/**
 * The `session-expiry` job (B053): a run calls the session lifecycle's sweep at the current time
 * and logs counts only; `session.expiry.sweep` repeats every 60 s under one scheduler, however often
 * it is scheduled. A failing run is tried 3 times in all, backing off with jitter, then is
 * dead-lettered, counted and logged by error kind only.
 */
import { Writable } from 'node:stream';
import { createLogger, type MetricLabels, type Metrics } from '@centcom/core';
import { UnrecoverableError, type Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  onSessionExpiryFailed,
  processSessionExpiry,
  scheduleSessionExpiry,
  SESSION_EXPIRY_EVERY_MS,
  SESSION_EXPIRY_JOB,
  SESSION_EXPIRY_SCHEDULER_ID,
  sessionExpiryJobOptions,
} from '../src/index.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

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

describe('processSessionExpiry', () => {
  it('sweeps at the current time and logs the counts only', async () => {
    const swept: Date[] = [];
    const log = captureLogger();
    const result = await processSessionExpiry({
      sessions: {
        sweep: (now) => {
          swept.push(now);
          return Promise.resolve({ paused: 2, expired: 1 });
        },
      },
      clock: () => NOW,
      logger: log.logger,
    });
    expect(result).toEqual({ paused: 2, expired: 1 });
    expect(swept).toEqual([new Date(NOW)]);
    expect(log.lines()).toEqual([
      expect.objectContaining({ msg: 'session.expiry_swept', paused: 2, expired: 1 }),
    ]);
  });
});

describe('scheduleSessionExpiry', () => {
  it('upserts one scheduler running session.expiry.sweep every 60 s with the retry options', async () => {
    const calls: unknown[][] = [];
    const queue = {
      upsertJobScheduler: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    } as unknown as Queue;
    await scheduleSessionExpiry(queue);
    await scheduleSessionExpiry(queue);
    expect(calls).toEqual([
      [
        SESSION_EXPIRY_SCHEDULER_ID,
        { every: 60_000 },
        { name: 'session.expiry.sweep', opts: sessionExpiryJobOptions() },
      ],
      [
        SESSION_EXPIRY_SCHEDULER_ID,
        { every: 60_000 },
        { name: 'session.expiry.sweep', opts: sessionExpiryJobOptions() },
      ],
    ]);
    expect([SESSION_EXPIRY_EVERY_MS, SESSION_EXPIRY_JOB]).toEqual([60_000, 'session.expiry.sweep']);
  });
});

describe('retries', () => {
  it('are 3 attempts from 5 s with jitter; then dead-lettered, counted and logged by kind', () => {
    expect(sessionExpiryJobOptions()).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    const counters = countingMetrics();
    const log = captureLogger();
    const options = { logger: log.logger, metrics: counters.metrics };
    const failed = (attemptsMade: number) => ({
      id: 'repeat-1',
      attemptsMade,
      opts: sessionExpiryJobOptions(),
    });
    const err = new Error('connect ECONNREFUSED db.internal:5432');
    onSessionExpiryFailed(failed(1), err, options);
    onSessionExpiryFailed(failed(2), err, options);
    expect(counters.count('session_expiry_failed_total')).toBe(0);
    onSessionExpiryFailed(failed(3), err, options);
    onSessionExpiryFailed(failed(1), new UnrecoverableError('bad'), options);
    onSessionExpiryFailed(undefined, err, options);
    expect(counters.count('session_expiry_failed_total')).toBe(2);
    expect(log.lines().map((l) => l['msg'])).toEqual([
      'session.expiry_retry',
      'session.expiry_retry',
      'session.expiry_failed',
      'session.expiry_failed',
    ]);
    expect(JSON.stringify(log.lines())).not.toContain('db.internal');
  });
});
