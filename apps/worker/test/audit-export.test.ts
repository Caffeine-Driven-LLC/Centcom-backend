/**
 * The `audit-export` queue (B082): an export job runs the API's export runner with whether it is
 * the last of its 3 attempts (fixed 10 s apart; the runner fails the export on the last one); the
 * sweep, every 5 minutes, expires files and queues again the exports it finds stuck, by export id,
 * so an export is never queued twice. Dead letters are counted and logged by kind only. On Redis 7
 * (REDIS_URL, CI's integration job): a run that keeps failing is attempted 3 times, told on the
 * third that it is the last, then dead-lettered.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { newId } from '@centcom/contracts';
import { defineConfig, z } from '@centcom/core';
import { UnrecoverableError, type Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUDIT_EXPORT_SWEEP_EVERY_MS,
  AUDIT_EXPORT_SWEEP_SCHEDULER_ID,
  auditExportJobOptions,
  createAuditExportQueue,
  enqueueAuditExport,
  onAuditExportFailed,
  processAuditExport,
  scheduleAuditExportSweep,
  startAuditExportWorker,
  type AuditExportDeps,
} from '../src/jobs/audit-export/index.js';

function recordingQueue() {
  const added: { name: string; data: unknown; opts: unknown }[] = [];
  return {
    added,
    add: (name: string, data: unknown, opts: unknown) => {
      added.push({ name, data, opts });
      return Promise.resolve({} as never);
    },
  };
}

function deps(over: Partial<AuditExportDeps> = {}) {
  const runs: { id: string; finalAttempt: boolean }[] = [];
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, msg: string) => lines.push({ msg, fields }),
    warn: (fields: Record<string, unknown>, msg: string) => lines.push({ msg, fields }),
  };
  const d: AuditExportDeps = {
    run: (id, opts) => {
      runs.push({ id, ...opts });
      return Promise.resolve('ready');
    },
    sweep: () => Promise.resolve({ expired: 0, failed: 0, stale: [] }),
    clock: () => Date.UTC(2026, 9, 8, 12, 0, 0),
    logger: logger as never,
    ...over,
  };
  return { d, runs, lines };
}

describe('audit-export jobs', () => {
  it('queues an export once, by its id, with 3 attempts 10 s apart', async () => {
    const queue = recordingQueue();
    const id = newId('exp');
    await enqueueAuditExport(queue as never, id);
    expect(queue.added).toEqual([
      {
        name: 'export',
        data: { exportId: id },
        opts: {
          attempts: 3,
          backoff: { type: 'fixed', delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: { age: 604_800 },
          jobId: id,
        },
      },
    ]);
    expect(auditExportJobOptions().attempts).toBe(3);
  });

  it('tells the runner whether the attempt is the last', async () => {
    const { d, runs } = deps();
    const id = newId('exp');
    for (const attemptsMade of [0, 1, 2]) {
      const result = await processAuditExport(
        { id, name: 'export', data: { exportId: id }, attemptsMade, opts: { attempts: 3 } },
        d,
        recordingQueue() as never,
      );
      expect(result).toBe('ready');
    }
    expect(runs.map((r) => r.finalAttempt)).toEqual([false, false, true]);
    expect(runs.every((r) => r.id === id)).toBe(true);
  });

  it('refuses a job without an export id, without retrying', async () => {
    const { d, runs } = deps();
    for (const data of [{}, { exportId: 'exp_nope' }, null, { exportId: newId('wsp') }]) {
      await expect(
        processAuditExport(
          { id: '1', name: 'export', data, attemptsMade: 0, opts: { attempts: 3 } },
          d,
          recordingQueue() as never,
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(runs).toEqual([]);
  });

  it('sweeps, and queues the stuck exports it finds again', async () => {
    const stale = [newId('exp'), newId('exp')];
    const sweeps: Date[] = [];
    const { d, lines } = deps({
      sweep: (now) => {
        sweeps.push(now);
        return Promise.resolve({ expired: 2, failed: 1, stale });
      },
    });
    const queue = recordingQueue();
    const result = await processAuditExport(
      { id: 's', name: 'sweep', data: {}, attemptsMade: 0, opts: {} },
      d,
      queue as never,
    );
    expect(result).toBe('swept');
    expect(sweeps.map((s) => s.toISOString())).toEqual(['2026-10-08T12:00:00.000Z']);
    expect(queue.added.map((a) => [a.name, (a.opts as { jobId: string }).jobId])).toEqual([
      ['export', stale[0]],
      ['export', stale[1]],
    ]);
    expect(lines).toEqual([
      { msg: 'audit_export.swept', fields: { expired: 2, failed: 1, requeued: 2 } },
    ]);
  });

  it('schedules one sweep every 5 minutes', async () => {
    const calls: unknown[][] = [];
    const queue = { upsertJobScheduler: (...args: unknown[]) => Promise.resolve(calls.push(args)) };
    await scheduleAuditExportSweep(queue as never);
    expect(calls).toEqual([
      [
        AUDIT_EXPORT_SWEEP_SCHEDULER_ID,
        { every: AUDIT_EXPORT_SWEEP_EVERY_MS },
        {
          name: 'sweep',
          opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 604_800 } },
        },
      ],
    ]);
    expect(AUDIT_EXPORT_SWEEP_EVERY_MS).toBe(300_000);
  });

  it('logs retries, and counts dead letters by kind only', () => {
    const counted: string[] = [];
    const { d, lines } = deps();
    const metrics = {
      counter: (name: string, labels?: Record<string, string>) => ({
        inc: () => counted.push(`${name}${JSON.stringify(labels ?? {})}`),
      }),
      histogram: () => ({ observe: () => undefined }),
    };
    const job = { id: 'exp_x', name: 'export', attemptsMade: 1, opts: { attempts: 3 } };
    onAuditExportFailed(job, new Error('connect ECONNREFUSED db.internal:5432'), { ...d, metrics });
    onAuditExportFailed({ ...job, attemptsMade: 3 }, new Error('secret host'), { ...d, metrics });
    expect(lines.map((l) => l.msg)).toEqual(['audit_export.retry', 'audit_export.dead_letter']);
    expect(JSON.stringify(lines)).not.toContain('db.internal');
    expect(JSON.stringify(lines)).not.toContain('secret host');
    expect(counted).toEqual(['audit_export_dead_letters_total{"job":"export"}']);
  });
});

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`not within ${timeoutMs} ms`);
    await sleep(20);
  }
}

describe.runIf(REDIS_URL !== undefined)('the audit-export queue on Redis 7', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    for (const thing of open.splice(0)) await thing.close();
  });

  it('attempts a failing export 3 times, the third as the last, then dead-letters it', async () => {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue: Queue = createAuditExportQueue({ connection, prefix });
    const finals: boolean[] = [];
    const worker = startAuditExportWorker({
      connection,
      prefix,
      queue,
      run: (_id, { finalAttempt }) => {
        finals.push(finalAttempt);
        return Promise.reject(new Error('object store down'));
      },
      sweep: () => Promise.resolve({ expired: 0, failed: 0, stale: [] }),
    });
    open.push(worker, queue, { close: () => connection.quit() });
    const id = newId('exp');
    // The real options, but 20 ms apart so the test need not wait 20 s.
    await queue.add(
      'export',
      { exportId: id },
      { ...auditExportJobOptions(), backoff: { type: 'fixed', delay: 20 }, jobId: id },
    );
    // Queued again while it exists: ignored.
    await enqueueAuditExport(queue, id);
    await until(async () => (await queue.getFailedCount()) === 1);
    expect(finals).toEqual([false, false, true]);
    expect((await queue.getJob(id))?.attemptsMade).toBe(3);
  });
});
