/**
 * The `account-export` and `account-purge` queues (B026):
 *
 * - an export job runs the API's runner with whether it is the last of its 5 attempts
 *   (exponential backoff with jitter); bad data is unrecoverable; the sweep requeues stuck exports
 *   by export id; dead letters are counted and logged by kind only;
 * - a purge job is delayed until the deadline with job id `purge-<usr>`, and cancelling removes
 *   it; `waiting` throws so BullMQ retries; the sweep queues every due user at once; after the
 *   last attempt `account_purge_failed_total` counts the failure.
 */
import { newId } from '@centcom/contracts';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_EXPORT_ATTEMPTS,
  ACCOUNT_EXPORT_SWEEP_JOB,
  accountExportJobOptions,
  enqueueAccountExport,
  onAccountExportFailed,
  processAccountExport,
  scheduleAccountExportSweep,
  type AccountExportDeps,
} from '../src/jobs/account-export.js';
import {
  ACCOUNT_PURGE_ATTEMPTS,
  ACCOUNT_PURGE_SWEEP_JOB,
  accountPurgeJobId,
  AccountPurgeWaitingError,
  cancelAccountPurge,
  onAccountPurgeFailed,
  processAccountPurge,
  scheduleAccountPurge,
  scheduleAccountPurgeSweep,
  type AccountPurgeDeps,
  type AccountPurgeOutcome,
} from '../src/jobs/account-purge.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function recordingQueue() {
  const added: { name: string; data: unknown; opts: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const schedulers: { id: string; repeat: unknown; template: unknown }[] = [];
  return {
    added,
    removed,
    schedulers,
    add: (name: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ name, data, opts });
      return Promise.resolve({} as never);
    },
    remove: (id: string) => {
      removed.push(id);
      return Promise.resolve(1);
    },
    upsertJobScheduler: (id: string, repeat: unknown, template: unknown) => {
      schedulers.push({ id, repeat, template });
      return Promise.resolve({} as never);
    },
  };
}

function logs() {
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  const push = (fields: Record<string, unknown>, msg: string) => lines.push({ msg, fields });
  return { lines, logger: { info: push, warn: push, error: push } as never };
}

function counting() {
  const counts = new Map<string, number>();
  return {
    counts,
    metrics: {
      counter: (name: string) => ({
        inc: (n = 1) => counts.set(name, (counts.get(name) ?? 0) + n),
      }),
    } as never,
  };
}

describe('account-export jobs', () => {
  it('runs an export, telling the runner which attempt is the last', async () => {
    const runs: { id: string; finalAttempt: boolean }[] = [];
    const deps: AccountExportDeps = {
      run: (id, opts) => {
        runs.push({ id, ...opts });
        return Promise.resolve('ready');
      },
      sweep: () => Promise.resolve({ expired: 0, stale: [] }),
    };
    const id = newId('exp');
    const queue = recordingQueue();
    const job = (attemptsMade: number) => ({
      id,
      name: 'export',
      data: { exportId: id },
      attemptsMade,
      opts: { attempts: ACCOUNT_EXPORT_ATTEMPTS },
    });
    expect(await processAccountExport(job(0), deps, queue)).toBe('ready');
    expect(await processAccountExport(job(4), deps, queue)).toBe('ready');
    expect(runs).toEqual([
      { id, finalAttempt: false },
      { id, finalAttempt: true },
    ]);
    await expect(
      processAccountExport({ ...job(0), data: { exportId: 'nope' } }, deps, queue),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('queues exports once, by id, with 5 attempts and jittered exponential backoff', async () => {
    const queue = recordingQueue();
    const id = newId('exp');
    await enqueueAccountExport(queue, id);
    expect(queue.added).toEqual([
      { name: 'export', data: { exportId: id }, opts: { ...accountExportJobOptions(), jobId: id } },
    ]);
    expect(accountExportJobOptions()).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000, jitter: 0.5 },
    });
  });

  it('sweeps: requeues stuck exports and schedules itself once', async () => {
    const stuck = [newId('exp'), newId('exp')];
    const { lines, logger } = logs();
    const deps: AccountExportDeps = {
      run: () => Promise.resolve('ready'),
      sweep: (now) => {
        expect(now.getTime()).toBe(NOW);
        return Promise.resolve({ expired: 3, stale: stuck });
      },
      clock: () => NOW,
      logger,
    };
    const queue = recordingQueue();
    const sweep = { id: 'x', name: ACCOUNT_EXPORT_SWEEP_JOB, data: {}, attemptsMade: 0, opts: {} };
    expect(await processAccountExport(sweep, deps, queue)).toBe('swept');
    expect(queue.added.map((a) => a.opts['jobId'])).toEqual(stuck);
    expect(lines).toEqual([{ msg: 'account_export.swept', fields: { expired: 3, requeued: 2 } }]);
    await scheduleAccountExportSweep(queue);
    expect(queue.schedulers).toHaveLength(1);
    expect(queue.schedulers[0]?.repeat).toEqual({ every: 15 * 60 * 1000 });
  });

  it('counts a dead letter once, by kind only', () => {
    const { lines, logger } = logs();
    const { counts, metrics } = counting();
    const job = { id: 'j', name: 'export', attemptsMade: 1, opts: { attempts: 5 } };
    onAccountExportFailed(job, new Error('https://secret.host/'), { logger, metrics });
    expect(counts.size).toBe(0);
    onAccountExportFailed({ ...job, attemptsMade: 5 }, new Error('https://secret.host/'), {
      logger,
      metrics,
    });
    expect(counts.get('account_export_dead_letters_total')).toBe(1);
    expect(JSON.stringify(lines)).not.toContain('secret.host');
    onAccountExportFailed(undefined, new Error('x'), { logger, metrics });
  });
});

describe('account-purge jobs', () => {
  function purgeDeps(outcome: AccountPurgeOutcome, due: string[] = []) {
    const purged: string[] = [];
    const deps: AccountPurgeDeps = {
      purge: (userId) => {
        purged.push(userId);
        return Promise.resolve(outcome);
      },
      due: () => Promise.resolve(due),
      clock: () => NOW,
    };
    return { deps, purged };
  }

  it('delays the purge until the deadline, one job per user, and cancels it', async () => {
    const queue = recordingQueue();
    const userId = newId('usr');
    const deadline = new Date(NOW + 30 * 24 * 60 * 60 * 1000);
    await scheduleAccountPurge(queue, userId, deadline, new Date(NOW));
    expect(queue.added[0]).toMatchObject({
      name: 'purge',
      data: { userId },
      opts: { jobId: `purge-${userId}`, delay: 30 * 24 * 60 * 60 * 1000, attempts: 10 },
    });
    expect(accountPurgeJobId(userId)).not.toContain(':');
    // A deadline in the past runs at once.
    await scheduleAccountPurge(queue, userId, new Date(NOW - 1000), new Date(NOW));
    expect(queue.added[1]?.opts['delay']).toBe(0);
    await cancelAccountPurge(queue, userId);
    expect(queue.removed).toEqual([`purge-${userId}`]);
  });

  it('runs the purge and retries while it waits for workspace purges', async () => {
    const userId = newId('usr');
    const job = { id: 'j', name: 'purge', data: { userId }, attemptsMade: 0 };
    const queue = recordingQueue();
    const done = purgeDeps('deleted');
    expect(await processAccountPurge(job, done.deps, queue)).toBe('deleted');
    expect(done.purged).toEqual([userId]);
    const waiting = purgeDeps('waiting');
    await expect(processAccountPurge(job, waiting.deps, queue)).rejects.toBeInstanceOf(
      AccountPurgeWaitingError,
    );
    await expect(
      processAccountPurge({ ...job, data: { userId: 'nope' } }, done.deps, queue),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('sweeps: queues every due user at once, and schedules itself hourly', async () => {
    const due = [newId('usr'), newId('usr')];
    const { deps } = purgeDeps('deleted', due);
    const queue = recordingQueue();
    const sweep = { id: 's', name: ACCOUNT_PURGE_SWEEP_JOB, data: {}, attemptsMade: 0 };
    expect(await processAccountPurge(sweep, deps, queue)).toBe('swept');
    expect(queue.added.map((a) => [a.opts['jobId'], a.opts['delay']])).toEqual(
      due.map((u) => [`purge-${u}`, 0]),
    );
    await scheduleAccountPurgeSweep(queue);
    expect(queue.schedulers[0]?.repeat).toEqual({ every: 60 * 60 * 1000 });
  });

  it('counts account_purge_failed_total after the last attempt only', () => {
    const { lines, logger } = logs();
    const { counts, metrics } = counting();
    const userId = newId('usr');
    const job = { id: 'j', name: 'purge', data: { userId }, attemptsMade: 3, opts: {} };
    onAccountPurgeFailed(job, new Error('x'), { logger, metrics });
    expect(counts.get('account_purge_failed_total')).toBeUndefined();
    onAccountPurgeFailed({ ...job, attemptsMade: ACCOUNT_PURGE_ATTEMPTS }, new Error('x'), {
      logger,
      metrics,
    });
    expect(counts.get('account_purge_failed_total')).toBe(1);
    expect(lines.at(-1)).toMatchObject({
      msg: 'account_purge.failed',
      fields: { user_id: userId },
    });
    onAccountPurgeFailed({ ...job, data: {} }, new UnrecoverableError('bad'), { logger, metrics });
    expect(lines.at(-1)?.fields['user_id']).toBe('invalid');
  });
});
