/**
 * Row and audit policies (B090), in memory:
 *
 * - a row policy deletes its due rows ROW_BATCH at a time until none is due; counts only in a dry
 *   run; aborts with `fraction_exceeded` before deleting anything when more than the allowed share
 *   of the table is due (test plan "brake test"), unless forced or the table is one whose rows live
 *   minutes (`guard: false`); stops cleanly on a spent budget with the backlog;
 * - the audit policy deletes each workspace's events older than its `audit_log_days` (0: all of
 *   them) through the store's purge, skips a workspace whose entitlements cannot be read, keeps
 *   the old days for 7 days after a downgrade (CT-ENTITLEMENTS "no data is deleted immediately"),
 *   and applies the brake to every workspace but those already keeping none (or new at 0 days):
 *   a shortening to 0 that applies tonight and old events first seen at 0 days stay under it; a
 *   table estimate below the events known due is never subtracted from; a budget spent while
 *   counting still deletes for the workspaces counted, and the next run continues after them;
 * - the telemetry report counts raw telemetry past 90 days and deletes nothing;
 * - the registry: every policy of the docs, in order, with the brake off only for login tokens,
 *   device codes and staff audit details, then the extra policies of other lanes.
 */
import { describe, expect, it } from 'vitest';
import {
  createAuditPolicy,
  createRetentionPolicies,
  createRowPolicy,
  createTelemetryReportPolicy,
  FRESH_DAYS,
  RetentionAbort,
  ROW_BATCH,
  ROW_POLICIES,
  TELEMETRY_RAW_DAYS,
  type AuditRetentionStore,
  type RetentionPolicy,
  type RowRetentionStore,
} from '../../src/index.js';
import {
  captureLogger,
  ctxOf,
  DAY,
  historyWorld,
  memoryCursor,
  memoryState,
  newId,
  NOW,
  PRO,
  recordingMailer,
  recordingNotices,
  scriptedEntitlements,
  TEAM,
} from './helpers.js';

/** A table of `total` rows, the first `due` of them due. */
function table(total: number, due: number) {
  const state = { total, due, purges: [] as number[] };
  const store: RowRetentionStore = {
    count: () => Promise.resolve({ due: state.due, total: state.total }),
    purge(_now, limit) {
      const n = Math.min(limit, state.due);
      state.due -= n;
      state.total -= n;
      state.purges.push(n);
      return Promise.resolve(n);
    },
  };
  return { state, store };
}

describe('row policies', () => {
  it('deletes the due rows a batch at a time until none is due', async () => {
    const t = table(100_000, 2_500);
    const policy = createRowPolicy({ id: 'notifications', owner: 'B063', store: t.store });
    expect(await policy.run(ctxOf())).toEqual({ scanned: 2_500, purged: 2_500, skipped: 0 });
    expect(t.state.purges).toEqual([ROW_BATCH, ROW_BATCH, 500]);
    expect(await policy.run(ctxOf())).toEqual({ scanned: 0, purged: 0, skipped: 0 });
  });

  it('counts only in a dry run', async () => {
    const t = table(100, 10);
    const policy = createRowPolicy({ id: 'notifications', owner: 'B063', store: t.store });
    expect(await policy.run(ctxOf({ dryRun: true }))).toEqual({
      scanned: 10,
      purged: 0,
      skipped: 0,
    });
    expect(t.state.purges).toEqual([]);
  });

  it('aborts before deleting when more than the allowed share is due, unless forced', async () => {
    const t = table(1_000, 201);
    const policy = createRowPolicy({ id: 'webhook_log', owner: 'B081', store: t.store });
    await expect(policy.run(ctxOf())).rejects.toMatchObject({
      reason: 'fraction_exceeded',
      scanned: 201,
    });
    expect(t.state.purges).toEqual([]);
    expect(await policy.run(ctxOf({ maxDeleteFraction: 0.25 }))).toMatchObject({ purged: 201 });
    const again = table(1_000, 500);
    const forced = createRowPolicy({ id: 'webhook_log', owner: 'B081', store: again.store });
    expect(await forced.run(ctxOf({ force: true }))).toMatchObject({ purged: 500 });
    // Exactly the allowed share is not more than it.
    const edge = table(1_000, 200);
    const exact = createRowPolicy({ id: 'webhook_log', owner: 'B081', store: edge.store });
    expect(await exact.run(ctxOf())).toMatchObject({ purged: 200 });
  });

  it('never brakes a table whose rows live minutes', async () => {
    const t = table(1_000, 990);
    const policy = createRowPolicy({
      id: 'login_tokens',
      owner: 'B014',
      store: t.store,
      guard: false,
    });
    expect(await policy.run(ctxOf())).toMatchObject({ purged: 990 });
  });

  it('stops cleanly on a spent budget and reports the backlog', async () => {
    const t = table(100_000, 3_000);
    let now = 0;
    const policy = createRowPolicy({ id: 'notifications', owner: 'B063', store: t.store });
    const result = await policy.run(
      ctxOf({
        budgetMs: 1500,
        clock: () => {
          now += 1000;
          return now;
        },
      }),
    );
    expect(result).toEqual({
      scanned: 3_000,
      purged: 1_000,
      skipped: 0,
      backlog: 2_000,
      stopped: 'budget_exceeded',
    });
  });
});

/** Audit events per workspace, with creation times. */
function auditEvents() {
  const events: { workspaceId: string; createdAt: Date }[] = [];
  const store: AuditRetentionStore = {
    workspacesWithEvents(after, limit) {
      const ids = [...new Set(events.map((e) => e.workspaceId))]
        .sort()
        .filter((id) => after === null || id > after);
      return Promise.resolve(ids.slice(0, limit));
    },
    dueEvents: (ws, before) =>
      Promise.resolve(
        events.filter((e) => e.workspaceId === ws && e.createdAt.getTime() < before.getTime())
          .length,
      ),
    totalEvents: () => Promise.resolve(events.length),
    purge(ws, before, limit) {
      let n = 0;
      for (let i = events.length - 1; i >= 0 && n < limit; i -= 1) {
        const e = events[i];
        if (e !== undefined && e.workspaceId === ws && e.createdAt.getTime() < before.getTime()) {
          events.splice(i, 1);
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };
  return {
    events,
    store,
    add(ws: string, daysAgo: number, count = 1) {
      for (let i = 0; i < count; i += 1) {
        events.push({ workspaceId: ws, createdAt: new Date(NOW.getTime() - daysAgo * DAY) });
      }
    },
    of: (ws: string) => events.filter((e) => e.workspaceId === ws).length,
  };
}

describe('audit retention', () => {
  it('keeps audit_log_days of events per workspace, none at 0, and skips unreadable entitlements', async () => {
    const a = auditEvents();
    const entitlements = scriptedEntitlements();
    const team = newId('wsp');
    const pro = newId('wsp');
    const broken = newId('wsp');
    entitlements.set(team, TEAM);
    entitlements.set(pro, PRO);
    entitlements.set(broken, new Error('timeout'));
    a.add(team, 100, 3); // past 90 days
    a.add(team, 10, 20);
    a.add(pro, 1, 2); // audit_log_days 0: all due
    a.add(broken, 400, 20);
    const captured = captureLogger();
    const policy = createAuditPolicy({
      store: a.store,
      state: memoryState().store,
      cursor: memoryCursor().cursor,
      entitlements: entitlements.port,
      logger: captured.logger,
    });
    expect(await policy.run(ctxOf())).toEqual({ scanned: 5, purged: 5, skipped: 0 });
    expect(a.of(team)).toBe(20);
    expect(a.of(pro)).toBe(0);
    expect(a.of(broken)).toBe(20);
    expect(captured.lines().find((l) => l['msg'] === 'retention.workspace_skipped')).toMatchObject({
      workspace_id: broken,
      reason: 'entitlements_failed',
    });
  });

  it('keeps the old days for 7 days after a downgrade, then applies the new ones', async () => {
    const a = auditEvents();
    const entitlements = scriptedEntitlements();
    const state = memoryState();
    const ws = newId('wsp');
    const other = newId('wsp');
    entitlements.set(ws, TEAM);
    entitlements.set(other, TEAM);
    a.add(ws, 10, 5);
    a.add(other, 10, 100); // keeps the brake quiet
    const policy = createAuditPolicy({
      store: a.store,
      state: state.store,
      cursor: memoryCursor().cursor,
      entitlements: entitlements.port,
    });
    await policy.run(ctxOf());
    expect(state.datasets.audit.baseline.get(ws)).toBe(90);
    entitlements.set(ws, { ...TEAM, audit_log_days: 7 }); // the downgrade
    expect(await policy.run(ctxOf())).toMatchObject({ purged: 0 });
    expect(a.of(ws)).toBe(5);
    expect(state.datasets.audit.pending.get(ws)).toMatchObject({ oldDays: 90, newDays: 7 });
    const later = new Date(NOW.getTime() + 7 * DAY + 5 * 60 * 1000);
    expect(await policy.run(ctxOf({ now: later }))).toMatchObject({ purged: 5 });
    expect(a.of(ws)).toBe(0);
    expect(state.datasets.audit.baseline.get(ws)).toBe(7);
    expect(state.datasets.audit.pending.has(ws)).toBe(false);
  });

  it('applies the brake to the workspaces keeping events, not to those already keeping none', async () => {
    const a = auditEvents();
    const entitlements = scriptedEntitlements();
    const state = memoryState();
    const team = newId('wsp');
    const pro = newId('wsp');
    entitlements.set(team, TEAM);
    entitlements.set(pro, PRO);
    a.add(team, 10, 10);
    a.add(pro, 1, 1_000); // new, at 0 days: all due every night by design
    const policy = createAuditPolicy({
      store: a.store,
      state: state.store,
      cursor: memoryCursor().cursor,
      entitlements: entitlements.port,
    });
    expect(await policy.run(ctxOf())).toMatchObject({ scanned: 1_000, purged: 1_000 });
    a.add(pro, 0.5, 1_000); // the next day's, its 0 days now recorded
    expect(await policy.run(ctxOf())).toMatchObject({ scanned: 1_000, purged: 1_000 });

    // A corrupted small value (1 day) for a Team workspace seen for the first time trips it.
    const b = auditEvents();
    const corrupted = newId('wsp');
    const kept = newId('wsp');
    entitlements.set(corrupted, { ...TEAM, audit_log_days: 1 });
    entitlements.set(kept, TEAM);
    b.add(corrupted, 2, 10);
    b.add(kept, 10, 10);
    const second = createAuditPolicy({
      store: b.store,
      state: memoryState().store,
      cursor: memoryCursor().cursor,
      entitlements: entitlements.port,
    });
    await expect(second.run(ctxOf())).rejects.toBeInstanceOf(RetentionAbort);
    expect(b.of(corrupted)).toBe(10);
    expect(await second.run(ctxOf({ dryRun: true, force: true }))).toEqual({
      scanned: 10,
      purged: 0,
      skipped: 0,
    });
  });

  it('keeps under the brake the workspaces whose events would all go for the first time', async () => {
    const entitlements = scriptedEntitlements();
    // First seen at 0 days, with events older than a new workspace has.
    const a = auditEvents();
    const oldEvents = newId('wsp');
    const kept = newId('wsp');
    entitlements.set(oldEvents, PRO);
    entitlements.set(kept, TEAM);
    a.add(oldEvents, FRESH_DAYS + 1, 10);
    a.add(kept, 10, 10);
    const first = createAuditPolicy({
      store: a.store,
      state: memoryState().store,
      cursor: memoryCursor().cursor,
      entitlements: entitlements.port,
    });
    await expect(first.run(ctxOf())).rejects.toBeInstanceOf(RetentionAbort);
    expect(a.of(oldEvents)).toBe(10);

    // A shortening from 90 days to 0 that applies tonight.
    const b = auditEvents();
    const downgraded = newId('wsp');
    const other = newId('wsp');
    entitlements.set(downgraded, TEAM);
    entitlements.set(other, TEAM);
    b.add(downgraded, 10, 10);
    b.add(other, 10, 10);
    const second = createAuditPolicy({
      store: b.store,
      state: memoryState().store,
      cursor: memoryCursor().cursor,
      entitlements: entitlements.port,
    });
    await second.run(ctxOf());
    entitlements.set(downgraded, PRO);
    expect(await second.run(ctxOf())).toMatchObject({ purged: 0 });
    const applies = ctxOf({ now: new Date(NOW.getTime() + 7 * DAY + 5 * 60 * 1000) });
    await expect(second.run(applies)).rejects.toBeInstanceOf(RetentionAbort);
    expect(b.of(downgraded)).toBe(10);
  });

  it('never brakes on a table estimate below the events known due', async () => {
    const a = auditEvents();
    const entitlements = scriptedEntitlements();
    const state = memoryState();
    const team = newId('wsp');
    const pro = newId('wsp');
    entitlements.set(team, TEAM);
    entitlements.set(pro, PRO);
    const policy = (store: AuditRetentionStore) =>
      createAuditPolicy({
        store,
        state: state.store,
        cursor: memoryCursor().cursor,
        entitlements: entitlements.port,
      });
    a.add(team, 10, 9);
    a.add(pro, 1, 10);
    await policy(a.store).run(ctxOf()); // Team keeps 90 days, Pro none
    a.add(team, 100, 1); // one Team event past its 90 days
    a.add(pro, 0.5, 1_000); // a day of a workspace keeping none
    // The planner's estimate lags the 1 010 rows: 990, below the 1 000 known due at 0 days.
    const estimated: AuditRetentionStore = { ...a.store, totalEvents: () => Promise.resolve(990) };
    expect(await policy(estimated).run(ctxOf())).toMatchObject({ scanned: 1_001, purged: 1_001 });
    expect(a.of(team)).toBe(9);
  });

  it('deletes for the workspaces it counted when the budget runs out while counting, then continues', async () => {
    const a = auditEvents();
    const entitlements = scriptedEntitlements();
    const cursor = memoryCursor();
    const workspaces = [newId('wsp'), newId('wsp'), newId('wsp')].sort();
    for (const ws of workspaces) {
      entitlements.set(ws, PRO);
      a.add(ws, 1, 5);
    }
    let now = 0;
    const policy = createAuditPolicy({
      store: a.store,
      state: memoryState().store,
      cursor: cursor.cursor,
      // Counting a workspace takes a second: half of a 4 s budget is spent after two of them.
      entitlements: {
        get: (ws) => {
          now += 1000;
          return entitlements.port.get(ws);
        },
      },
    });
    expect(await policy.run(ctxOf({ budgetMs: 4000, clock: () => now }))).toEqual({
      scanned: 10,
      purged: 10,
      skipped: 0,
      backlog: 0,
      stopped: 'budget_exceeded',
    });
    expect(workspaces.map((ws) => a.of(ws))).toEqual([0, 0, 5]);
    expect(await cursor.of('audit')).toBe(workspaces[1]);
    expect(await policy.run(ctxOf())).toEqual({ scanned: 5, purged: 5, skipped: 0 });
    expect(await cursor.of('audit')).toBeNull();
  });
});

describe('telemetry report', () => {
  it('counts raw telemetry past 90 days and deletes nothing', async () => {
    const calls: [Date, number][] = [];
    const captured = captureLogger();
    const policy = createTelemetryReportPolicy({
      store: {
        overdue: (now, days) => {
          calls.push([now, days]);
          return Promise.resolve(12);
        },
      },
      logger: captured.logger,
    });
    expect(await policy.run(ctxOf())).toEqual({ scanned: 12, purged: 0, skipped: 0 });
    expect(calls).toEqual([[NOW, TELEMETRY_RAW_DAYS]]);
    expect(TELEMETRY_RAW_DAYS).toBe(90);
    expect(captured.lines().find((l) => l['msg'] === 'retention.telemetry_overdue')).toMatchObject({
      level: 'warn',
      events: 12,
    });
  });
});

describe('the registry', () => {
  it('lists history, audit and every row policy in order', () => {
    const world = historyWorld();
    const rows = Object.fromEntries(ROW_POLICIES.map((p) => [p.id, table(0, 0).store]));
    const extra: RetentionPolicy = {
      id: 'share_links',
      owner: 'B068',
      run: () => Promise.resolve({ scanned: 0, purged: 0, skipped: 0 }),
    };
    const policies = createRetentionPolicies({
      cursor: memoryCursor().cursor,
      stores: {
        state: world.state.store,
        history: world.store,
        audit: auditEvents().store,
        telemetry: { overdue: () => Promise.resolve(0) },
        rows: rows as Record<(typeof ROW_POLICIES)[number]['id'], RowRetentionStore>,
      },
      history: world.history,
      entitlements: scriptedEntitlements().port,
      notices: recordingNotices().port,
      mailer: recordingMailer().port,
      extra: [extra],
    });
    expect(policies.map((p) => `${p.id}:${p.owner}`)).toEqual([
      'history:B055',
      'audit:B036',
      'audit_staff_details:B087',
      'webhook_log:B081',
      'notifications:B063',
      'refresh_tokens:B017',
      'login_tokens:B014',
      'device_codes:B016',
      'invites:B029',
      'account_exports:B026',
      'audit_exports:B082',
      'stripe_events:B072',
      'billing_outbox:B072',
      'billing_trials:B079',
      'retention_runs:B090',
      'telemetry:B085',
      'share_links:B068',
    ]);
    expect(ROW_POLICIES.filter((p) => !p.guard).map((p) => p.id)).toEqual([
      'audit_staff_details',
      'login_tokens',
      'device_codes',
    ]);
  });
});
