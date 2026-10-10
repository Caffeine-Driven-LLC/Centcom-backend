/**
 * The `retention` queue and the workspace purge (B090; acceptance 8 "Deleting a workspace calls
 * purgeWorkspace and removes all of its blobs and rows within 5 min for a 10 000-frame history,
 * and writes an audit event with counts", in memory here and on Postgres in
 * retention.postgres.test.ts; interfaces "BullMQ jobs retention.run {policy?} (cron 03:00 UTC)
 * and retention.purge-workspace {workspaceId}"; config `RETENTION_DRY_RUN`, `RETENTION_FORCE`,
 * `RETENTION_MAX_DELETE_FRACTION=0.2`):
 *
 * - `purgeWorkspace` purges every session of the workspace (any state), history and snapshots,
 *   writes one `history.purge` audit event with the counts (outside the workspace, target the
 *   workspace), and runs as B027's `retention` purge hook; a second purge deletes nothing;
 * - the processor: `run` (all policies or one; a malformed policy is not retried; a failed or
 *   locked policy fails the job for a retry after the others ran), `purge-workspace` (a bad
 *   workspace id is not retried), unknown jobs refused; job options, the 03:00 UTC schedule and
 *   the per-workspace job id;
 * - configuration: dry run by default outside production, the brake's share checked;
 * - the notice body follows CT-WS-SESSION-EVENTS' Notices table (`history_retention_changed
 *   {days}`, level `info`); the email template renders the workspace, the days and the date.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, createEmailService, createMemoryRedis } from '@centcom/core';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  createPurgeHookRegistry,
  createWorkspacePurger,
  enqueueWorkspaceRetentionPurge,
  HISTORY_RETENTION_TEMPLATE_ID,
  loadRetentionConfig,
  processRetention,
  registerRetentionPurgeHook,
  registerRetentionTemplates,
  RETENTION_ATTEMPTS,
  RETENTION_PURGE_HOOK,
  RETENTION_RUN_PATTERN,
  RETENTION_SCHEDULER_ID,
  RetentionRunIncomplete,
  retentionJobOptions,
  retentionNoticeOf,
  scheduleRetention,
  type PolicyReport,
} from '../../src/index.js';
import { historyWorld, newId } from './helpers.js';

function purgerWith() {
  const world = historyWorld();
  const audit: unknown[] = [];
  const purger = createWorkspacePurger({
    sessions: world.sessionsReader,
    history: world.history,
    snapshots: world.snapshots,
    audit: { emitDetached: (event) => audit.push(event) },
  });
  return { world, audit, purger };
}

describe('purgeWorkspace (acceptance 8)', () => {
  it('purges every session of a 10 000-frame workspace within 5 min, and audits the counts', async () => {
    const p = purgerWith();
    const ws = p.world.workspace();
    const other = p.world.workspace();
    const sessions = [
      p.world.session(ws, { state: 'live', endedDaysAgo: null, frames: 5_000 }),
      p.world.session(ws, { endedDaysAgo: 1, frames: 4_000 }),
      p.world.session(ws, { state: 'paused', endedDaysAgo: null, frames: 1_000 }),
    ];
    const kept = p.world.session(other, { endedDaysAgo: 400, frames: 10 });
    const started = performance.now();
    // 5 000 + 4 000 + 1 000 frames in 10 + 8 + 2 blobs, plus one snapshot each.
    expect(await p.purger.purgeWorkspace(ws)).toEqual({ blobs: 23, rows: 10_003 });
    expect(performance.now() - started).toBeLessThan(5 * 60 * 1000);
    for (const sid of sessions) {
      expect(p.world.sessions.get(sid)).toMatchObject({ frames: 0, blobs: 0, snapshots: 0 });
    }
    expect(p.world.frames(kept)).toBe(10);
    expect(p.audit).toEqual([
      {
        workspaceId: null,
        actor: { type: 'system', id: 'retention' },
        action: 'history.purge',
        target: { type: 'workspace', id: ws },
        outcome: 'success',
        meta: { frames: 10_003, blobs: 23 },
      },
    ]);
    // A retry that finds nothing left writes no second event.
    expect(await p.purger.purgeWorkspace(ws)).toEqual({ blobs: 0, rows: 0 });
    expect(p.audit).toHaveLength(1);
  });

  it('runs as B027’s retention purge hook', async () => {
    const p = purgerWith();
    const ws = p.world.workspace();
    const sid = p.world.session(ws, { frames: 30 });
    const hooks = createPurgeHookRegistry();
    registerRetentionPurgeHook(hooks, p.purger);
    const [hook] = hooks.list();
    expect(hook?.name).toBe(RETENTION_PURGE_HOOK);
    await hook?.hook(ws, { now: 0, attempt: 1 });
    expect(p.world.frames(sid)).toBe(0);
    expect(() => registerRetentionPurgeHook(hooks, p.purger)).toThrow(TypeError);
  });
});

describe('the retention queue', () => {
  const report = (policy: string, outcome: PolicyReport['outcome']): PolicyReport => ({
    policy,
    outcome,
    scanned: 0,
    purged: 0,
    skipped: 0,
    backlog: 0,
  });

  it('runs every policy, or one, and fails for a retry when one failed or was locked', async () => {
    const calls: unknown[] = [];
    let reports: PolicyReport[] = [report('history', 'done'), report('audit', 'fraction_exceeded')];
    const deps = {
      runner: {
        run: (options: { policy?: string }) => {
          calls.push(options);
          if (options.policy === 'nope') return Promise.reject(new TypeError('unknown'));
          return Promise.resolve(reports);
        },
      },
      purger: purgerWith().purger,
    };
    expect(await processRetention({ name: 'run', data: {} }, deps)).toEqual(reports);
    await processRetention({ name: 'run', data: { policy: 'audit' } }, deps);
    expect(calls).toEqual([{}, { policy: 'audit' }]);
    await expect(
      processRetention({ name: 'run', data: { policy: 'Bad Id' } }, deps),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processRetention({ name: 'run', data: { policy: 'nope' } }, deps),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    reports = [report('history', 'failed'), report('audit', 'locked'), report('invites', 'done')];
    const failed = await processRetention({ name: 'run', data: {} }, deps).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(RetentionRunIncomplete);
    expect((failed as RetentionRunIncomplete).policies).toEqual(['history', 'audit']);
  });

  it('purges a workspace on request, and refuses bad ids and unknown jobs', async () => {
    const p = purgerWith();
    const ws = p.world.workspace();
    p.world.session(ws, { frames: 7 });
    const deps = { runner: { run: () => Promise.resolve([]) }, purger: p.purger };
    expect(
      await processRetention({ name: 'purge-workspace', data: { workspaceId: ws } }, deps),
    ).toEqual({ blobs: 2, rows: 8 });
    await expect(
      processRetention({ name: 'purge-workspace', data: { workspaceId: 'wsp_bad' } }, deps),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processRetention({ name: 'other', data: {} }, deps)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('schedules the run at 03:00 UTC, retries with backoff and jitter, and queues a purge once', async () => {
    expect(retentionJobOptions()).toEqual({
      attempts: RETENTION_ATTEMPTS,
      backoff: { type: 'exponential', delay: 180_000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
    const schedules: unknown[] = [];
    await scheduleRetention({
      upsertJobScheduler: (...args: unknown[]) => {
        schedules.push(args);
        return Promise.resolve(undefined as never);
      },
    } as never);
    expect(schedules).toEqual([
      [
        RETENTION_SCHEDULER_ID,
        { pattern: RETENTION_RUN_PATTERN, tz: 'UTC' },
        { name: 'run', data: {}, opts: retentionJobOptions() },
      ],
    ]);
    expect(RETENTION_RUN_PATTERN).toBe('0 3 * * *');
    const added: unknown[] = [];
    const ws = newId('wsp');
    await enqueueWorkspaceRetentionPurge(
      { add: (...args: unknown[]) => Promise.resolve(added.push(args) as never) } as never,
      ws,
    );
    expect(added).toEqual([
      [
        'purge-workspace',
        { workspaceId: ws },
        { ...retentionJobOptions(10_000), jobId: `purge-workspace-${ws}` },
      ],
    ]);
    expect(`purge-workspace-${ws}`).not.toContain(':');
    await expect(
      enqueueWorkspaceRetentionPurge({ add: () => Promise.resolve() } as never, 'x'),
    ).rejects.toThrow(TypeError);
  });
});

describe('configuration', () => {
  it('runs dry by default outside production, and checks the brake’s share', () => {
    expect(loadRetentionConfig({})).toEqual({ dryRun: true, force: false, maxDeleteFraction: 0.2 });
    expect(loadRetentionConfig({ NODE_ENV: 'production' }).dryRun).toBe(false);
    expect(loadRetentionConfig({ NODE_ENV: 'production', RETENTION_DRY_RUN: 'true' }).dryRun).toBe(
      true,
    );
    expect(loadRetentionConfig({ RETENTION_DRY_RUN: '0' }).dryRun).toBe(false);
    expect(
      loadRetentionConfig({ RETENTION_FORCE: '1', RETENTION_MAX_DELETE_FRACTION: '0.35' }),
    ).toMatchObject({ force: true, maxDeleteFraction: 0.35 });
    expect(loadRetentionConfig({ RETENTION_MAX_DELETE_FRACTION: '1' }).maxDeleteFraction).toBe(1);
    for (const bad of ['0', '1.5', '-0.2', 'abc', '20%']) {
      expect(() => loadRetentionConfig({ RETENTION_MAX_DELETE_FRACTION: bad }), bad).toThrow(
        ConfigError,
      );
    }
    expect(() => loadRetentionConfig({ RETENTION_FORCE: 'yes' })).toThrow(ConfigError);
  });
});

describe('what a shortening tells people', () => {
  it('sends a notice the Notices table lists, with its params and level', () => {
    const doc = readFileSync(
      resolve(import.meta.dirname, '../../../../contracts/04-session-events.md'),
      'utf8',
    );
    expect(doc).toMatch(/\| `history_retention_changed` \| `\{days\}` \|/);
    expect(doc).toMatch(/`history_retention_changed`→`info`/);
    expect(retentionNoticeOf(7)).toEqual({
      code: 'history_retention_changed',
      level: 'info',
      params: { days: 7 },
    });
  });

  it('renders the owners’ email with the workspace, the days and the date', () => {
    const redis = createMemoryRedis();
    const email = createEmailService({
      queue: { add: () => Promise.resolve({ id: 'j' }) },
      rateLimit: redis.rateLimit,
      kv: redis.kv,
      from: 'Centcom <no-reply@example.test>',
    });
    registerRetentionTemplates(email.templates);
    const rendered = email.render(HISTORY_RETENTION_TEMPLATE_ID, {
      workspaceName: 'Acme <b>',
      days: '7',
      effectiveAt: new Date('2026-10-22T03:00:00.000Z'),
    });
    expect(rendered.text).toContain(
      'Acme <b> keeps session history for 7 days after a session ends',
    );
    expect(rendered.html).toContain('Acme &lt;b&gt;');
    expect(rendered.html).not.toContain('Acme <b>');
    const none = email.render(HISTORY_RETENTION_TEMPLATE_ID, {
      workspaceName: 'Acme',
      days: '0',
      effectiveAt: new Date('2026-10-22T03:00:00.000Z'),
    });
    expect(none.text).toContain('no longer keeps session history');
  });
});
