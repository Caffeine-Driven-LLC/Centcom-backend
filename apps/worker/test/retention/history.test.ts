/**
 * History retention (B090), in memory:
 *
 * - acceptance 1: for a Pro workspace (`history_days: 7`), a session ended 8 days ago loses its
 *   durable log, its snapshots and the rows; one ended 6 days ago is untouched; pending, live and
 *   paused sessions are never purged, whatever their age; nor are sessions without an end time or
 *   outside any workspace;
 * - acceptance 3: a downgrade from 30 to 7 days records one pending shortening, sends exactly one
 *   `history_retention_changed {days: 7}` notice and one email, purges nothing newer than 30 days
 *   until 7 days later (± 5 min), then purges what is older than 7 days; a re-upgrade within the 7
 *   days withdraws it (test plan "downgrade-notice scenario test including cancellation"); an
 *   email that went out a day late moves the purge a day later (7 days of notice either way); the
 *   7 days count from when the notice went out (the wall clock), not from the run's start;
 * - acceptance 4 through the policy: an override of 30 on a 7-day plan enforces 7, one of 3
 *   enforces 3;
 * - failure modes: entitlements that cannot be read skip the workspace (never 0 days, logged at
 *   warn); a notice or email that fails is retried next run, without repeating what went out;
 * - failure path: blob deletes failing for 10 % of the sessions leave those sessions whole (no
 *   metadata without its blob) and the run completes; the next run purges them;
 * - throttling: a store answering 503 halves the concurrency (rounds of 4, then 2, then back up),
 *   the sessions are retried after a backoff and all purged, and the run does not fail;
 * - a due session holding blobs but no index rows is purged too;
 * - dry run: counts only; brake: a corrupted `history_days: 0` on first sight would delete most
 *   of the history, so the policy aborts with `fraction_exceeded` and deletes nothing (unless
 *   forced); budget: a spent budget stops cleanly with the backlog, in either pass, and reports a
 *   stop that leaves only sessions without frames;
 * - the cursor (failure mode "Run exceeds the 30 min budget -> stops cleanly, continues next
 *   night"): deciding stops at half the budget and the workspaces decided are acted on; the next
 *   run starts after the last workspace finished and wraps around to the first; a stop while
 *   purging leaves the cursor at the last workspace finished; a dry run that ran out while
 *   counting says so and leaves the cursor.
 */
import { describe, expect, it } from 'vitest';
import {
  createHistoryPolicy,
  HISTORY_CONCURRENCY,
  RetentionAbort,
  type RetentionContext,
} from '../../src/index.js';
import {
  captureLogger,
  countingMetrics,
  ctxOf,
  DAY,
  historyWorld,
  NOW,
  PRO,
  recordingMailer,
  recordingNotices,
  memoryCursor,
  scriptedEntitlements,
  TEAM,
} from './helpers.js';

function setup() {
  const world = historyWorld();
  const entitlements = scriptedEntitlements();
  const cursor = memoryCursor();
  /** The tests' clock; each entitlements read moves it on by `perDecide` ms (0 by default). */
  const clock = { now: 0, perDecide: 0 };
  const notices = recordingNotices();
  const mailer = recordingMailer();
  const captured = captureLogger();
  const counted = countingMetrics();
  const sleeps: number[] = [];
  const policy = createHistoryPolicy({
    store: world.store,
    state: world.state.store,
    cursor: cursor.cursor,
    history: world.history,
    snapshots: world.snapshots,
    entitlements: {
      get: (ws) => {
        clock.now += clock.perDecide;
        return entitlements.port.get(ws);
      },
    },
    notices: notices.port,
    mailer: mailer.port,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    logger: captured.logger,
    metrics: counted.metrics,
  });
  return {
    world,
    entitlements,
    cursor,
    clock,
    notices,
    mailer,
    captured,
    counted,
    sleeps,
    policy,
  };
}

/** A context `days` (plus `plusMs`) after NOW; the brake is tested on its own. */
const at = (days: number, plusMs = 0): RetentionContext =>
  ctxOf({ now: new Date(NOW.getTime() + days * DAY + plusMs), maxDeleteFraction: 1 });

describe('history retention', () => {
  it('purges a Pro session ended 8 days ago, keeps one ended 6 days ago, never live ones (acceptance 1)', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, PRO);
    const old = s.world.session(ws, { endedDaysAgo: 8, frames: 40 });
    const expired = s.world.session(ws, { state: 'expired', endedDaysAgo: 9, frames: 5 });
    const recent = s.world.session(ws, { endedDaysAgo: 6, frames: 30 });
    const live = s.world.session(ws, { state: 'live', endedDaysAgo: 400, frames: 50 });
    const paused = s.world.session(ws, { state: 'paused', endedDaysAgo: 400, frames: 50 });
    const pending = s.world.session(ws, { state: 'pending', endedDaysAgo: null, frames: 50 });
    const noEnd = s.world.session(ws, { endedDaysAgo: null, frames: 20 });
    const outside = s.world.session(null, { endedDaysAgo: 400, frames: 20 });

    const result = await s.policy.run(ctxOf({ maxDeleteFraction: 1 }));
    expect(result).toEqual({ scanned: 45, purged: 45, skipped: 0 });
    expect(s.world.sessions.get(old)).toMatchObject({ frames: 0, blobs: 0, snapshots: 0 });
    expect(s.world.sessions.get(expired)).toMatchObject({ frames: 0, blobs: 0, snapshots: 0 });
    for (const kept of [recent, live, paused, pending, noEnd, outside]) {
      expect(s.world.frames(kept), kept).toBeGreaterThan(0);
      expect(s.world.sessions.get(kept)?.snapshots).toBe(1);
    }
    expect(s.world.baseline.get(ws)).toBe(7);
    expect(s.notices.published).toEqual([]);
    // Logs carry counts and workspace ids, never session ids.
    expect(JSON.stringify(s.captured.lines())).not.toContain(old);
  });

  it('gives 7 days of notice on a downgrade from 30 to 7, once, then purges (acceptance 3)', async () => {
    const s = setup();
    const ws = s.world.workspace('Acme');
    s.entitlements.set(ws, TEAM);
    const tenDays = s.world.session(ws, { endedDaysAgo: 10, frames: 20 });
    const fortyDays = s.world.session(ws, { endedDaysAgo: 40, frames: 10 });
    await s.policy.run(ctxOf({ maxDeleteFraction: 1 })); // baseline 30; the 40-day session goes
    expect(s.world.frames(fortyDays)).toBe(0);
    expect(s.world.baseline.get(ws)).toBe(30);

    s.entitlements.set(ws, PRO); // the downgrade
    const first = await s.policy.run(ctxOf());
    expect(first.purged).toBe(0);
    expect(s.world.frames(tenDays)).toBe(20);
    const effectiveAt = new Date(NOW.getTime() + 7 * DAY);
    expect(s.world.pending.get(ws)).toEqual({
      oldDays: 30,
      newDays: 7,
      effectiveAt,
      noticeSentAt: NOW,
      emailSentAt: NOW,
    });
    expect(s.notices.published).toEqual([
      {
        channel: `relay:notice:${ws}`,
        message: { code: 'history_retention_changed', level: 'info', params: { days: 7 } },
      },
    ]);
    expect(s.mailer.sent).toEqual([
      {
        id: 'history_retention_changed',
        to: s.world.owners.get(ws)?.emails[0],
        params: { workspaceName: 'Acme', days: '7', effectiveAt },
        idempotencyKey: `retention:${ws}:${effectiveAt.getTime()}`,
      },
    ]);

    // The next nights, until 5 minutes before the 7 days are up: nothing more sent or purged.
    await s.policy.run(at(1));
    await s.policy.run(at(7, -5 * 60 * 1000));
    expect(s.world.frames(tenDays)).toBe(20);
    expect(s.notices.published).toHaveLength(1);
    expect(s.mailer.sent).toHaveLength(1);

    // 5 minutes after: 7 days are enforced (the session ended 17 days before).
    const applied = await s.policy.run(at(7, 5 * 60 * 1000));
    expect(applied.purged).toBe(20);
    expect(s.world.frames(tenDays)).toBe(0);
    expect(s.world.pending.has(ws)).toBe(false);
    expect(s.world.baseline.get(ws)).toBe(7);
    expect(s.notices.published).toHaveLength(1);
  });

  it('withdraws a shortening when the plan comes back within the 7 days', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, TEAM);
    const session = s.world.session(ws, { endedDaysAgo: 10, frames: 20 });
    await s.policy.run(ctxOf());
    s.entitlements.set(ws, PRO);
    await s.policy.run(ctxOf());
    expect(s.world.pending.has(ws)).toBe(true);

    s.entitlements.set(ws, TEAM); // re-upgrade 3 days later
    await s.policy.run(at(3));
    expect(s.world.pending.has(ws)).toBe(false);
    expect(s.world.baseline.get(ws)).toBe(30);
    await s.policy.run(at(8)); // past the old 7 days: the session (18 days old) stays
    expect(s.world.frames(session)).toBe(20);
    expect(s.notices.published).toHaveLength(1);
  });

  it('enforces an override only when it is shorter (acceptance 4)', async () => {
    const s = setup();
    const longer = s.world.workspace();
    const shorter = s.world.workspace();
    s.entitlements.set(longer, PRO);
    s.entitlements.set(shorter, PRO);
    s.world.overrides.set(longer, 30);
    s.world.overrides.set(shorter, 3);
    const longerEight = s.world.session(longer, { endedDaysAgo: 8 });
    const longerSix = s.world.session(longer, { endedDaysAgo: 6 });
    const shorterFour = s.world.session(shorter, { endedDaysAgo: 4 });
    const shorterTwo = s.world.session(shorter, { endedDaysAgo: 2 });
    await s.policy.run(ctxOf({ maxDeleteFraction: 1 }));
    expect(s.world.baseline.get(longer)).toBe(7);
    expect(s.world.baseline.get(shorter)).toBe(3);
    expect(s.world.frames(longerEight)).toBe(0);
    expect(s.world.frames(longerSix)).toBe(10);
    expect(s.world.frames(shorterFour)).toBe(0);
    expect(s.world.frames(shorterTwo)).toBe(10);
  });

  it('skips a workspace whose entitlements cannot be read, never taking them for 0 days', async () => {
    const s = setup();
    const failing = s.world.workspace();
    const unknown = s.world.workspace();
    s.entitlements.set(failing, new Error('connection terminated'));
    s.entitlements.set(unknown, null);
    const a = s.world.session(failing, { endedDaysAgo: 400 });
    const b = s.world.session(unknown, { endedDaysAgo: 400 });
    const result = await s.policy.run(ctxOf({ maxDeleteFraction: 1 }));
    expect(result).toEqual({ scanned: 0, purged: 0, skipped: 0 });
    expect(s.world.frames(a)).toBe(10);
    expect(s.world.frames(b)).toBe(10);
    expect(s.world.baseline.size).toBe(0);
    const skipped = s.captured.lines().filter((l) => l['msg'] === 'retention.workspace_skipped');
    expect(skipped).toEqual([
      expect.objectContaining({
        level: 'warn',
        workspace_id: failing,
        reason: 'entitlements_failed',
        error: 'Error',
      }),
      expect.objectContaining({
        level: 'warn',
        workspace_id: unknown,
        reason: 'entitlements_unavailable',
      }),
    ]);
    expect(
      s.counted.count('retention_workspaces_skipped_total', {
        policy: 'history',
        reason: 'entitlements_failed',
      }),
    ).toBe(1);
  });

  it('retries a failed notice or email next run without repeating what went out', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, TEAM);
    s.world.session(ws, { endedDaysAgo: 10 });
    await s.policy.run(ctxOf());
    s.entitlements.set(ws, PRO);
    s.mailer.failures.push(new Error('EmailProviderError'));
    await s.policy.run(ctxOf());
    expect(s.notices.published).toHaveLength(1);
    expect(s.mailer.sent).toHaveLength(0);
    expect(s.world.pending.get(ws)).toMatchObject({ noticeSentAt: NOW, emailSentAt: null });
    expect(s.counted.count('retention_notice_failures_total', { step: 'email' })).toBe(1);

    await s.policy.run(at(1));
    expect(s.notices.published).toHaveLength(1);
    expect(s.mailer.sent).toHaveLength(1);
    expect(s.world.pending.get(ws)?.emailSentAt).toEqual(new Date(NOW.getTime() + DAY));
  });

  it('completes a run when 10 % of the blob deletes fail, and purges the rest next run', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, PRO);
    const sessions = Array.from({ length: 10 }, () => s.world.session(ws, { endedDaysAgo: 30 }));
    const failing = sessions[3] ?? '';
    s.world.failPurge((sid) => (sid === failing ? new Error('BlobStoreError') : null));
    const result = await s.policy.run(ctxOf({ maxDeleteFraction: 1 }));
    expect(result).toEqual({ scanned: 100, purged: 90, skipped: 10 });
    expect(s.world.frames(failing)).toBe(10);
    expect(sessions.filter((sid) => s.world.frames(sid) === 0)).toHaveLength(9);
    expect(s.counted.count('retention_purge_failures_total', { policy: 'history' })).toBe(1);

    s.world.failPurge(() => null);
    expect(await s.policy.run(ctxOf({ maxDeleteFraction: 1 }))).toEqual({
      scanned: 10,
      purged: 10,
      skipped: 0,
    });
    expect(s.world.frames(failing)).toBe(0);
  });

  it('halves the concurrency when the store throttles, retries after a backoff, and purges everything', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, PRO);
    for (let i = 0; i < 12; i += 1) s.world.session(ws, { endedDaysAgo: 30 });
    s.world.throttle(3);
    const result = await s.policy.run(ctxOf({ maxDeleteFraction: 1 }));
    expect(result).toEqual({ scanned: 120, purged: 120, skipped: 0 });
    expect(s.world.maxInFlight()).toBe(HISTORY_CONCURRENCY);
    expect(s.counted.count('retention_throttled_total', { policy: 'history' })).toBe(3);
    expect(s.sleeps).toEqual([750]); // 1 s × 2^0 × (0.5 + 0.5 / 2)
    // Three throttled in the first round: 4 → 2, then back up by one per clean round.
    expect(s.world.rounds).toEqual([4, 2, 3, 4, 2]);
    expect(s.world.purgeCalls).toHaveLength(15);
  });

  it('moves the purge a day later when the email went out a day late', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, TEAM);
    const tenDays = s.world.session(ws, { endedDaysAgo: 10, frames: 20 });
    await s.policy.run(ctxOf());
    s.entitlements.set(ws, PRO);
    s.mailer.failures.push(new Error('EmailProviderError'));
    await s.policy.run(ctxOf()); // notice now, email fails
    await s.policy.run(at(1)); // email a day late
    await s.policy.run(at(7, 5 * 60 * 1000)); // 7 days after the notice, 6 after the email
    expect(s.world.frames(tenDays)).toBe(20);
    expect(s.world.pending.has(ws)).toBe(true);
    await s.policy.run(at(8, 5 * 60 * 1000)); // 7 days after the email
    expect(s.world.frames(tenDays)).toBe(0);
    expect(s.world.baseline.get(ws)).toBe(7);
  });

  it('counts the 7 days from when the notice went out, not from the start of the run', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, TEAM);
    const tenDays = s.world.session(ws, { endedDaysAgo: 10, frames: 20 });
    await s.policy.run(ctxOf());
    s.entitlements.set(ws, PRO);
    const sentAt = new Date(NOW.getTime() + 25 * 60 * 1000); // the run reached it 25 min in
    await s.policy.run(ctxOf({ clock: () => sentAt.getTime() }));
    expect(s.world.pending.get(ws)).toMatchObject({ noticeSentAt: sentAt, emailSentAt: sentAt });
    await s.policy.run(at(7)); // 7 days after that run started: 25 min short of the notice's
    expect(s.world.frames(tenDays)).toBe(20);
    await s.policy.run(at(8));
    expect(s.world.frames(tenDays)).toBe(0);
  });

  it('purges a due session that holds blobs but no index rows', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, PRO);
    const orphan = s.world.session(ws, { endedDaysAgo: 30, frames: 0 });
    const session = s.world.sessions.get(orphan);
    if (session !== undefined) session.blobs = 2; // written, never indexed
    expect(await s.policy.run(ctxOf())).toEqual({ scanned: 0, purged: 0, skipped: 0 });
    expect(s.world.purgeCalls).toEqual([orphan]);
    expect(s.world.sessions.get(orphan)?.blobs).toBe(0);
  });

  it('counts and writes nothing in a dry run', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, PRO);
    const session = s.world.session(ws, { endedDaysAgo: 30, frames: 25 });
    expect(await s.policy.run(ctxOf({ dryRun: true, maxDeleteFraction: 1 }))).toEqual({
      scanned: 25,
      purged: 0,
      skipped: 0,
    });
    expect(s.world.frames(session)).toBe(25);
    expect(s.world.baseline.size).toBe(0);
    expect(s.world.purgeCalls).toEqual([]);
  });

  it('aborts on a corrupted history_days of 0 that would delete most of the history (brake)', async () => {
    const s = setup();
    for (let i = 0; i < 5; i += 1) {
      const ws = s.world.workspace();
      s.entitlements.set(ws, { ...TEAM, history_days: 0 }); // corrupted
      s.world.session(ws, { endedDaysAgo: 2, frames: 100 });
    }
    const keep = s.world.workspace();
    s.entitlements.set(keep, TEAM);
    s.world.session(keep, { endedDaysAgo: 2, frames: 100 });
    const aborted = await s.policy.run(ctxOf()).catch((e: unknown) => e);
    expect(aborted).toBeInstanceOf(RetentionAbort);
    expect(aborted).toMatchObject({ reason: 'fraction_exceeded', scanned: 500 });
    expect(s.world.purgeCalls).toEqual([]);
    expect(s.world.baseline.size).toBe(0);

    const forced = await s.policy.run(ctxOf({ force: true }));
    expect(forced.purged).toBe(500);
  });

  it('stops cleanly when the budget is spent and reports the backlog', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, PRO);
    for (let i = 0; i < 3; i += 1) s.world.session(ws, { endedDaysAgo: 30 });
    let now = 0;
    const result = await s.policy.run(
      ctxOf({
        maxDeleteFraction: 1,
        budgetMs: 2500, // out of time at the first page of sessions
        clock: () => {
          now += 1000; // every look at the clock costs a second
          return now;
        },
      }),
    );
    expect(result).toEqual({
      scanned: 30,
      purged: 0,
      skipped: 0,
      backlog: 30,
      stopped: 'budget_exceeded',
    });
    expect(s.world.baseline.get(ws)).toBe(7);
  });

  it('reports a stop that leaves only sessions without frames', async () => {
    const s = setup();
    const ws = s.world.workspace();
    s.entitlements.set(ws, PRO);
    const orphans = Array.from({ length: HISTORY_CONCURRENCY + 1 }, () => {
      const sid = s.world.session(ws, { endedDaysAgo: 30, frames: 0 });
      const session = s.world.sessions.get(sid);
      if (session !== undefined) session.blobs = 1; // written, never indexed
      return sid;
    });
    const result = await s.policy.run(
      ctxOf({
        budgetMs: 4000,
        // Out of time once the first round of purges is done.
        clock: () => (s.world.purgeCalls.length > 0 ? 10_000 : 0),
      }),
    );
    expect(result).toEqual({
      scanned: 0,
      purged: 0,
      skipped: 0,
      backlog: 0,
      stopped: 'budget_exceeded',
    });
    expect(s.world.purgeCalls).toHaveLength(HISTORY_CONCURRENCY);
    expect(orphans.filter((sid) => s.world.sessions.get(sid)?.blobs === 1)).toHaveLength(1);
  });

  it('acts on the workspaces it decided when the budget runs out while deciding, and the next run continues', async () => {
    const s = setup();
    const workspaces = [s.world.workspace(), s.world.workspace(), s.world.workspace()].sort();
    const sessions = workspaces.map((ws) => {
      s.entitlements.set(ws, PRO);
      return s.world.session(ws, { endedDaysAgo: 30 });
    });
    // Deciding a workspace takes a second: half of a 4 s budget is spent after two of them.
    s.clock.perDecide = 1000;
    const result = await s.policy.run(
      ctxOf({ maxDeleteFraction: 1, budgetMs: 4000, clock: () => s.clock.now }),
    );
    expect(result).toEqual({
      scanned: 20,
      purged: 20,
      skipped: 0,
      backlog: 0,
      stopped: 'budget_exceeded',
    });
    expect(workspaces.map((ws) => s.world.baseline.get(ws))).toEqual([7, 7, undefined]);
    expect(sessions.map((sid) => s.world.frames(sid))).toEqual([0, 0, 10]);
    expect(await s.cursor.of('history')).toBe(workspaces[1]);

    // The next night starts after the last workspace finished and goes all the way round.
    s.clock.perDecide = 0;
    expect(await s.policy.run(at(1))).toEqual({ scanned: 10, purged: 10, skipped: 0 });
    expect(s.world.frames(sessions[2] ?? '')).toBe(0);
    expect(await s.cursor.of('history')).toBeNull();
  });

  it('starts after the cursor and wraps around to the first workspace', async () => {
    const s = setup();
    const workspaces = Array.from({ length: 4 }, () => s.world.workspace()).sort();
    const sessions = workspaces.map((ws) => {
      s.entitlements.set(ws, PRO);
      return s.world.session(ws, { endedDaysAgo: 30 });
    });
    await s.cursor.cursor.set('history', workspaces[1] ?? null);
    expect(await s.policy.run(ctxOf({ maxDeleteFraction: 1 }))).toEqual({
      scanned: 40,
      purged: 40,
      skipped: 0,
    });
    expect(s.world.purgeCalls).toEqual([sessions[2], sessions[3], sessions[0], sessions[1]]);
    expect(await s.cursor.of('history')).toBeNull();
  });

  it('leaves the cursor at the last workspace finished when the budget runs out while purging', async () => {
    const s = setup();
    const workspaces = [s.world.workspace(), s.world.workspace()].sort();
    for (const ws of workspaces) {
      s.entitlements.set(ws, PRO);
      s.world.session(ws, { endedDaysAgo: 30 });
    }
    const result = await s.policy.run(
      ctxOf({
        maxDeleteFraction: 1,
        budgetMs: 4000,
        // Out of time once the first workspace's session is purged.
        clock: () => (s.world.purgeCalls.length > 0 ? 10_000 : 0),
      }),
    );
    expect(result).toEqual({
      scanned: 20,
      purged: 10,
      skipped: 0,
      backlog: 10,
      stopped: 'budget_exceeded',
    });
    expect(await s.cursor.of('history')).toBe(workspaces[0]);
  });

  it('reports a dry run that ran out while counting, starting after the cursor and leaving it', async () => {
    const s = setup();
    const workspaces = [s.world.workspace(), s.world.workspace(), s.world.workspace()].sort();
    workspaces.forEach((ws, i) => {
      s.entitlements.set(ws, PRO);
      s.world.session(ws, { endedDaysAgo: 30, frames: 10 ** (i + 1) }); // 10, 100, 1000
    });
    await s.cursor.cursor.set('history', workspaces[0] ?? null);
    s.clock.perDecide = 1000; // half of the 2 s budget is spent after one workspace
    const result = await s.policy.run(
      ctxOf({ dryRun: true, maxDeleteFraction: 1, budgetMs: 2000, clock: () => s.clock.now }),
    );
    // Only the workspace after the cursor was counted.
    expect(result).toEqual({ scanned: 100, purged: 0, skipped: 0, stopped: 'budget_exceeded' });
    expect(s.world.purgeCalls).toEqual([]);
    expect(await s.cursor.of('history')).toBe(workspaces[0]);
  });
});
