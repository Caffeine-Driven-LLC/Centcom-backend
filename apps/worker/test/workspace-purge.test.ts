/**
 * The `workspace-purge` job (B027, card test workspace-purge.job.test.ts, acceptance 7): it
 * announces the deletion again, runs the registered hooks in registration order and ends with the
 * store's purge; a re-run is harmless; a failing hook stops the job before the purge; retries back
 * off exponentially with jitter; the dead letter is counted and logged. Then on Redis 7
 * (REDIS_URL, CI's integration job): a queued purge runs end to end, and a hook that keeps failing
 * is tried 5 times and dead-lettered.
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { newId } from '@centcom/contracts';
import {
  createLogger,
  createMemoryRedis,
  defineConfig,
  WORKSPACE_EVENTS_CHANNEL,
  WORKSPACE_PURGE_ATTEMPTS,
  WORKSPACE_PURGE_BACKOFF_TYPE,
  WORKSPACE_PURGE_FAILED_RETENTION_S,
  workspacePurgeJobId,
  workspacePurgeJobOptions,
  z,
  type MetricLabels,
  type Metrics,
  type WorkspacePurgeJobData,
} from '@centcom/core';
import { UnrecoverableError, type Queue, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPurgeHookRegistry,
  createWorkspacePurgeQueue,
  onWorkspacePurgeFailed,
  processWorkspacePurge,
  startWorkspacePurgeWorker,
  WORKSPACE_PURGE_BACKOFF_MAX_MS,
  workspacePurgeBackoff,
  type PurgeHookRegistry,
  type WorkspacePurgeDeps,
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

/** Deps recording what happens, in order. */
function deps(registry: PurgeHookRegistry = createPurgeHookRegistry()) {
  const steps: string[] = [];
  const store = {
    gone: new Set<string>(),
    purge(workspaceId: string) {
      steps.push(`purge:${workspaceId}`);
      const purged = !store.gone.has(workspaceId);
      store.gone.add(workspaceId);
      return Promise.resolve({ purged });
    },
  };
  const published: { channel: string; message: string }[] = [];
  const events = {
    publish(channel: string, message: string) {
      steps.push(`announce:${channel}`);
      published.push({ channel, message });
      return Promise.resolve();
    },
  };
  const counters = countingMetrics();
  const log = captureLogger();
  const purgeDeps: WorkspacePurgeDeps = {
    hooks: registry,
    store,
    events,
    clock: () => Date.UTC(2026, 9, 7, 12, 0, 0),
    logger: log.logger,
    metrics: counters.metrics,
  };
  return { purgeDeps, registry, steps, store, published, counters, log };
}

const job = (workspaceId: string, attemptsMade = 0) => ({
  id: workspacePurgeJobId(workspaceId),
  data: { workspaceId },
  attemptsMade,
});

describe('processWorkspacePurge', () => {
  it('announces, runs the hooks in registration order, then purges (acceptance 7)', async () => {
    const { purgeDeps, registry, steps, published, counters, log } = deps();
    const workspaceId = newId('wsp');
    for (const name of ['history', 'snapshots', 'billing']) {
      registry.register(name, (id, ctx) => {
        steps.push(`${name}:${id}:${ctx.attempt}`);
        return Promise.resolve();
      });
    }
    const result = await processWorkspacePurge(job(workspaceId), purgeDeps);
    expect(result).toEqual({ purged: true, hooks: 3 });
    expect(steps).toEqual([
      `announce:${WORKSPACE_EVENTS_CHANNEL}`,
      `history:${workspaceId}:1`,
      `snapshots:${workspaceId}:1`,
      `billing:${workspaceId}:1`,
      `purge:${workspaceId}`,
    ]);
    expect(JSON.parse(published[0]?.message ?? '{}')).toEqual({
      type: 'workspace.deleted',
      wsp: workspaceId,
      at: '2026-10-07T12:00:00.000Z',
    });
    expect(counters.count('workspace_purged_total')).toBe(1);
    expect(log.lines().find((l) => l['msg'] === 'workspace.purged')).toMatchObject({
      workspace_id: workspaceId,
      purged: true,
      hooks: 3,
    });
  });

  it('is harmless when run again: the hooks run again and the purge finds nothing (acceptance 7)', async () => {
    const { purgeDeps, registry, steps, counters } = deps();
    const workspaceId = newId('wsp');
    registry.register('history', () => {
      steps.push('history');
      return Promise.resolve();
    });
    await processWorkspacePurge(job(workspaceId), purgeDeps);
    const again = await processWorkspacePurge(job(workspaceId, 1), purgeDeps);
    expect(again).toEqual({ purged: false, hooks: 1 });
    expect(steps.filter((s) => s === 'history')).toHaveLength(2);
    expect(counters.count('workspace_purged_total')).toBe(1);
  });

  it('stops at a failing hook, before the purge, logging only the hook and the error kind', async () => {
    const { purgeDeps, registry, steps, log } = deps();
    const workspaceId = newId('wsp');
    registry.register('history', () =>
      Promise.reject(new TypeError('blob store said: secret-ish')),
    );
    registry.register('after', () => {
      steps.push('after');
      return Promise.resolve();
    });
    await expect(processWorkspacePurge(job(workspaceId), purgeDeps)).rejects.toThrow(TypeError);
    expect(steps).toEqual([`announce:${WORKSPACE_EVENTS_CHANNEL}`]);
    const line = log.lines().find((l) => l['msg'] === 'workspace.purge_hook_failed');
    expect(line).toMatchObject({ workspace_id: workspaceId, hook: 'history', error: 'TypeError' });
    expect(JSON.stringify(log.lines())).not.toContain('secret-ish');
  });

  it('refuses a job without a workspace id, for good', async () => {
    const { purgeDeps, steps } = deps();
    await expect(
      processWorkspacePurge({ id: 'x', data: { workspaceId: 'acme' }, attemptsMade: 0 }, purgeDeps),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(steps).toEqual([]);
  });
});

describe('the hook registry', () => {
  it('keeps registration order and refuses a name twice or a malformed one', () => {
    const registry = createPurgeHookRegistry();
    const hook = () => Promise.resolve();
    registry.register('b', hook);
    registry.register('a', hook);
    expect(registry.list().map((h) => h.name)).toEqual(['b', 'a']);
    expect(() => registry.register('a', hook)).toThrow(/already/);
    expect(() => registry.register('Bad Name', hook)).toThrow(TypeError);
  });
});

describe('retries', () => {
  it('back off from 10 s, doubling, between half and all of it, capped at 10 minutes', () => {
    const low = workspacePurgeBackoff(10_000, () => 0);
    const high = workspacePurgeBackoff(10_000, () => 1);
    expect([1, 2, 3, 4].map(low)).toEqual([5000, 10_000, 20_000, 40_000]);
    expect([1, 2, 3, 4].map(high)).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(high(20)).toBe(WORKSPACE_PURGE_BACKOFF_MAX_MS);
    expect(workspacePurgeBackoff()(1)).toBeGreaterThanOrEqual(5000);
  });

  it('are 5 attempts, with dead letters kept for a week', () => {
    expect(workspacePurgeJobOptions()).toEqual({
      attempts: WORKSPACE_PURGE_ATTEMPTS,
      backoff: { type: WORKSPACE_PURGE_BACKOFF_TYPE },
      removeOnComplete: true,
      removeOnFail: { age: WORKSPACE_PURGE_FAILED_RETENTION_S },
    });
    expect(WORKSPACE_PURGE_ATTEMPTS).toBe(5);
    expect(WORKSPACE_PURGE_FAILED_RETENTION_S).toBe(7 * 24 * 60 * 60);
  });

  it('log a retry, then count and log the dead letter (acceptance 7)', () => {
    const counters = countingMetrics();
    const log = captureLogger();
    const workspaceId = newId('wsp');
    const failed = (attemptsMade: number) => ({
      ...job(workspaceId, attemptsMade),
      opts: workspacePurgeJobOptions(),
    });
    const options = { logger: log.logger, metrics: counters.metrics };
    onWorkspacePurgeFailed(failed(1), new Error('x'), options);
    expect(counters.count('workspace_purge_failed_total')).toBe(0);
    onWorkspacePurgeFailed(failed(5), new Error('x'), options);
    expect(counters.count('workspace_purge_failed_total')).toBe(1);
    onWorkspacePurgeFailed(failed(1), new UnrecoverableError('bad job'), options);
    expect(counters.count('workspace_purge_failed_total')).toBe(2);
    onWorkspacePurgeFailed(undefined, new Error('x'), options);
    expect(log.lines().map((l) => l['msg'])).toEqual([
      'workspace.purge_retry',
      'workspace.purge_failed',
      'workspace.purge_failed',
    ]);
  });
});

const REDIS_URL = defineConfig(z.object({ REDIS_URL: z.string().optional() })).REDIS_URL;

/** Resolves once `check` holds, polling; rejects after `timeoutMs`. */
async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`not within ${timeoutMs} ms`);
    await sleep(20);
  }
}

describe.runIf(REDIS_URL !== undefined)('the workspace-purge queue on Redis 7', () => {
  const open: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    // The worker first, then the queue, then the connection they share.
    for (const thing of open.splice(0)) await thing.close();
  });

  /** A queue and a worker under a fresh prefix. */
  function pipeline(registry: PurgeHookRegistry) {
    const prefix = `ct:t${randomBytes(5).toString('hex')}:bull`;
    const connection = new Redis(REDIS_URL ?? '', { maxRetriesPerRequest: null });
    const queue: Queue<WorkspacePurgeJobData> = createWorkspacePurgeQueue({ connection, prefix });
    const recorded = deps(registry);
    const worker: Worker<WorkspacePurgeJobData> = startWorkspacePurgeWorker({
      ...recorded.purgeDeps,
      events: createMemoryRedis().pubsub,
      connection,
      prefix,
      backoffBaseMs: 20,
    });
    open.push(worker, queue, { close: () => connection.quit() });
    return { queue, ...recorded };
  }

  it('purges a queued workspace once, its hooks first (acceptance 7)', async () => {
    const registry = createPurgeHookRegistry();
    const ran: string[] = [];
    registry.register('history', (id) => {
      ran.push(id);
      return Promise.resolve();
    });
    const { queue, store } = pipeline(registry);
    const workspaceId = newId('wsp');
    const jobId = workspacePurgeJobId(workspaceId);
    await queue.add('purge', { workspaceId }, { jobId });
    await until(async () => store.gone.has(workspaceId));
    expect(ran).toEqual([workspaceId]);
    // Completed purges leave Redis.
    await until(async () => (await queue.getJob(jobId)) === undefined);
  });

  it('tries a failing hook 5 times, then leaves the job dead-lettered (acceptance 7)', async () => {
    const registry = createPurgeHookRegistry();
    let calls = 0;
    registry.register('history', () => {
      calls += 1;
      return Promise.reject(new Error('blob store down'));
    });
    const { queue, store, counters } = pipeline(registry);
    const workspaceId = newId('wsp');
    const jobId = workspacePurgeJobId(workspaceId);
    await queue.add('purge', { workspaceId }, { jobId });
    await until(async () => (await queue.getFailedCount()) === 1);
    expect((await queue.getJob(jobId))?.attemptsMade).toBe(5);
    expect(calls).toBe(5);
    expect(store.gone.has(workspaceId)).toBe(false);
    await until(async () => counters.count('workspace_purge_failed_total') === 1);
  });
});
