/**
 * Retention (B090): the SQL of the worker's retention policies (apps/worker `jobs/retention/`).
 *
 * - **Runs:** `retention_runs` rows, started and finished by the runner; unfinished ones of a
 *   policy closed as `interrupted`.
 * - **State:** the days enforced and the pending shortenings per workspace and dataset
 *   (`retention_baseline`, `retention_pending`).
 * - **History:** ended sessions holding history, per workspace; frames due by an end time; the
 *   workspace's name and active owners for the notice email. The purge itself is B055's history
 *   store.
 * - **Audit:** workspaces with audit events, counts, and deletion through `purge_audit_events()`.
 * - **Rows:** one store per row policy, each `count(now)` (due and total) and `purge(now, limit)`
 *   (oldest first, at most `limit` rows per statement). The rules are below, next to their SQL;
 *   docs/platform/data-retention.md lists them.
 * - **Telemetry:** a read-only count of raw events past 90 days (B085 drops them).
 *
 * A table's total for the fraction brake is exact while the table is small, and the planner's
 * estimate (`pg_class.reltuples`) once it has LARGE_TABLE_ROWS rows or more, so the nightly brake
 * never scans a large table whole.
 *
 * Every statement is parameterised. Owns: this SQL. Must not: decide retention (the worker's
 * policies do), or read any content column.
 */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { RetentionAbortReason, RetentionDataset, RetentionDb } from '../schema/retention.js';

/** A pending shortening, as the worker's policies use it. */
export interface RetentionPendingRecord {
  oldDays: number;
  newDays: number;
  effectiveAt: Date;
  noticeSentAt: Date | null;
  emailSentAt: Date | null;
}

/** A table's due rows (the worker's `RowRetentionStore`). */
export interface RetentionRowStore {
  count(now: Date): Promise<{ due: number; total: number }>;
  purge(now: Date, limit: number): Promise<number>;
}

/** The row policies' ids (the worker's ROW_POLICIES). */
export type RetentionRowPolicyId =
  | 'audit_staff_details'
  | 'webhook_log'
  | 'notifications'
  | 'refresh_tokens'
  | 'login_tokens'
  | 'device_codes'
  | 'invites'
  | 'account_exports'
  | 'audit_exports'
  | 'stripe_events'
  | 'billing_outbox'
  | 'billing_trials'
  | 'retention_runs';

/** From this many rows on, a table's total is the planner's estimate. */
export const LARGE_TABLE_ROWS = 100_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const before = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

/** Ended sessions whose history may be purged (never pending, live or paused ones). */
const ENDED = sql`s.state in ('ended', 'expired') and s.ended_at is not null`;
/** The session holds history (index rows, or a retention row left by an unfinished purge). */
const HOLDS_HISTORY = sql`(
  exists (select 1 from history_index h where h.session_id = s.id)
  or exists (select 1 from history_retention r where r.session_id = s.id)
)`;

const num = (value: string | number | bigint | null | undefined): number => Number(value ?? 0);

type Db = Kysely<RetentionDb>;

/** The rows of `table`: the planner's estimate when large, else an exact count. */
async function tableTotal(db: Db, table: string): Promise<number> {
  const estimate = await sql<{ rows: string | null }>`
    select reltuples::bigint as rows from pg_class where oid = to_regclass(${table})
  `.execute(db);
  const rows = num(estimate.rows[0]?.rows);
  if (rows >= LARGE_TABLE_ROWS) return rows;
  const exact = await sql<{ rows: string }>`
    select count(*) as rows from ${sql.table(table)}
  `.execute(db);
  return num(exact.rows[0]?.rows);
}

/** A row store from its rule: the due rows' WHERE (at `now`), and a batch delete. */
function rowStore(
  db: Db,
  table: string,
  due: (now: Date) => RawBuilder<unknown>,
  purge: (now: Date, limit: number) => Promise<number>,
): RetentionRowStore {
  return {
    async count(now) {
      const result = await sql<{ due: string }>`
        select count(*) as due from ${sql.table(table)} where ${due(now)}
      `.execute(db);
      return { due: num(result.rows[0]?.due), total: await tableTotal(db, table) };
    },
    purge,
  };
}

/** A row store deleting by primary key, oldest first by `orderBy`. */
function keyedRowStore(
  db: Db,
  table: string,
  key: string,
  orderBy: string,
  due: (now: Date) => RawBuilder<unknown>,
): RetentionRowStore {
  return rowStore(db, table, due, async (now, limit) => {
    const result = await sql`
      delete from ${sql.table(table)} where ${sql.ref(key)} in (
        select ${sql.ref(key)} from ${sql.table(table)}
        where ${due(now)}
        order by ${sql.ref(orderBy)}
        limit ${limit}
      )
    `.execute(db);
    return num(result.numAffectedRows);
  });
}

/**
 * Refresh-token families past their absolute expiry, whole families at a time (their rows
 * reference each other): families oldest first until about `limit` rows, at least one family.
 */
function refreshTokenStore(db: Db): RetentionRowStore {
  const due = (now: Date) => sql`absolute_expires_at < ${now}`;
  return rowStore(db, 'refresh_tokens', due, async (now, limit) => {
    const families = await sql<{ family_id: string; rows: string }>`
      select family_id, count(*) as rows from refresh_tokens
      where ${due(now)}
      group by family_id
      order by min(absolute_expires_at), family_id
      limit ${limit}
    `.execute(db);
    const picked: string[] = [];
    let rows = 0;
    for (const family of families.rows) {
      if (rows >= limit) break;
      picked.push(family.family_id);
      rows += num(family.rows);
    }
    if (picked.length === 0) return 0;
    const result = await sql`
      delete from refresh_tokens where family_id = any(${picked}::text[])
    `.execute(db);
    return num(result.numAffectedRows);
  });
}

/** The repository on Postgres. */
export function createRetentionRepository<DB extends RetentionDb>(database: Kysely<DB>) {
  const db = database as unknown as Db;

  const runs = {
    async closeInterrupted(policy: string, at: Date): Promise<number> {
      const result = await db
        .updateTable('retention_runs')
        .set({ finished_at: at, aborted_reason: 'interrupted' })
        .where('policy', '=', policy)
        .where('finished_at', 'is', null)
        .executeTakeFirst();
      return num(result.numUpdatedRows);
    },
    async start(policy: string, dryRun: boolean, at: Date): Promise<string> {
      const row = await db
        .insertInto('retention_runs')
        .values({ policy, dry_run: dryRun, started_at: at })
        .returning('id')
        .executeTakeFirstOrThrow();
      return String(row.id);
    },
    async finish(
      id: string,
      result: {
        scanned: number;
        purged: number;
        skipped: number;
        abortedReason: RetentionAbortReason | null;
      },
      at: Date,
    ): Promise<void> {
      await db
        .updateTable('retention_runs')
        .set({
          finished_at: at,
          scanned: result.scanned,
          purged: result.purged,
          skipped: result.skipped,
          aborted_reason: result.abortedReason,
        })
        .where('id', '=', id)
        .execute();
    },
    /** The latest runs (newest first), for the report. */
    async latest(limit: number) {
      return db
        .selectFrom('retention_runs')
        .selectAll()
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
    },
  };

  const upsertBaseline = (trx: Db, workspaceId: string, dataset: RetentionDataset, days: number) =>
    trx
      .insertInto('retention_baseline')
      .values({ workspace_id: workspaceId, dataset, days })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'dataset']).doUpdateSet({ days, updated_at: sql<Date>`now()` }),
      )
      .execute();

  const state = {
    async get(workspaceId: string, dataset: RetentionDataset) {
      const [baseline, pending] = await Promise.all([
        db
          .selectFrom('retention_baseline')
          .select('days')
          .where('workspace_id', '=', workspaceId)
          .where('dataset', '=', dataset)
          .executeTakeFirst(),
        db
          .selectFrom('retention_pending')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('dataset', '=', dataset)
          .executeTakeFirst(),
      ]);
      return {
        baseline: baseline?.days ?? null,
        pending:
          pending === undefined
            ? null
            : {
                oldDays: pending.old_days,
                newDays: pending.new_days,
                effectiveAt: pending.effective_at,
                noticeSentAt: pending.notice_sent_at,
                emailSentAt: pending.email_sent_at,
              },
      };
    },
    async setBaseline(workspaceId: string, dataset: RetentionDataset, days: number) {
      await upsertBaseline(db, workspaceId, dataset, days);
    },
    async announce(
      workspaceId: string,
      dataset: RetentionDataset,
      pending: RetentionPendingRecord,
    ) {
      await db
        .insertInto('retention_pending')
        .values({
          workspace_id: workspaceId,
          dataset,
          old_days: pending.oldDays,
          new_days: pending.newDays,
          effective_at: pending.effectiveAt,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'dataset']).doUpdateSet({
            old_days: pending.oldDays,
            new_days: pending.newDays,
            effective_at: pending.effectiveAt,
            notice_sent_at: null,
            email_sent_at: null,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    },
    async updatePending(workspaceId: string, dataset: RetentionDataset, newDays: number) {
      await db
        .updateTable('retention_pending')
        .set({ new_days: newDays, updated_at: sql<Date>`now()` })
        .where('workspace_id', '=', workspaceId)
        .where('dataset', '=', dataset)
        .execute();
    },
    async settle(workspaceId: string, dataset: RetentionDataset, days: number) {
      await db.transaction().execute(async (trx) => {
        await upsertBaseline(trx, workspaceId, dataset, days);
        await trx
          .deleteFrom('retention_pending')
          .where('workspace_id', '=', workspaceId)
          .where('dataset', '=', dataset)
          .execute();
      });
    },
    async markSent(
      workspaceId: string,
      dataset: RetentionDataset,
      what: 'notice' | 'email',
      at: Date,
    ) {
      const column = what === 'notice' ? 'notice_sent_at' : 'email_sent_at';
      await db
        .updateTable('retention_pending')
        .set({ [column]: at })
        .where('workspace_id', '=', workspaceId)
        .where('dataset', '=', dataset)
        .where(column, 'is', null)
        .execute();
    },
  };

  const history = {
    async workspacesWithHistory(after: string | null, limit: number): Promise<string[]> {
      const result = await sql<{ workspace_id: string }>`
        select distinct s.workspace_id from sessions s
        where s.workspace_id is not null and ${ENDED} and ${HOLDS_HISTORY}
          and (${after}::text is null or s.workspace_id > ${after})
        order by s.workspace_id
        limit ${limit}
      `.execute(db);
      return result.rows.map((r) => r.workspace_id);
    },
    async retentionOverride(workspaceId: string): Promise<number | null> {
      const row = await db
        .selectFrom('workspace_settings')
        .select('retention_days')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return row?.retention_days ?? null;
    },
    async dueFrames(workspaceId: string, endedBy: Date): Promise<number> {
      const result = await sql<{ frames: string }>`
        select count(*) as frames from history_index h
        join sessions s on s.id = h.session_id
        where s.workspace_id = ${workspaceId} and ${ENDED} and s.ended_at <= ${endedBy}
      `.execute(db);
      return num(result.rows[0]?.frames);
    },
    async dueSessions(workspaceId: string, endedBy: Date, after: string | null, limit: number) {
      const result = await sql<{ session_id: string; frames: string }>`
        select s.id as session_id,
          (select count(*) from history_index h where h.session_id = s.id) as frames
        from sessions s
        where s.workspace_id = ${workspaceId} and ${ENDED} and s.ended_at <= ${endedBy}
          and ${HOLDS_HISTORY}
          and (${after}::text is null or s.id > ${after})
        order by s.id
        limit ${limit}
      `.execute(db);
      return result.rows.map((r) => ({ sessionId: r.session_id, frames: num(r.frames) }));
    },
    totalFrames: (): Promise<number> => tableTotal(db, 'history_index'),
    async owners(workspaceId: string) {
      const workspace = await db
        .selectFrom('workspaces')
        .select('name')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      if (workspace === undefined) return null;
      const owners = await db
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select('users.email')
        .where('memberships.workspace_id', '=', workspaceId)
        .where('memberships.role', '=', 'owner')
        .where('users.status', '=', 'active')
        .orderBy('users.email')
        .execute();
      return { workspaceName: workspace.name, emails: owners.map((o) => String(o.email)) };
    },
  };

  /** The sessions of a workspace, whatever their state (for a deleted workspace's purge). */
  const sessions = {
    async sessionIds(workspaceId: string): Promise<string[]> {
      const rows = await db
        .selectFrom('sessions')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .orderBy('id')
        .execute();
      return rows.map((r) => r.id);
    },
  };

  const audit = {
    async workspacesWithEvents(after: string | null, limit: number): Promise<string[]> {
      const result = await sql<{ id: string }>`
        select w.id from workspaces w
        where (${after}::text is null or w.id > ${after})
          and exists (select 1 from audit_events a where a.workspace_id = w.id)
        order by w.id
        limit ${limit}
      `.execute(db);
      return result.rows.map((r) => r.id);
    },
    async dueEvents(workspaceId: string, cutoff: Date): Promise<number> {
      const result = await sql<{ events: string }>`
        select count(*) as events from audit_events
        where workspace_id = ${workspaceId} and created_at < ${cutoff}
      `.execute(db);
      return num(result.rows[0]?.events);
    },
    totalEvents: (): Promise<number> => tableTotal(db, 'audit_events'),
    async purge(workspaceId: string, cutoff: Date, limit: number): Promise<number> {
      const result = await sql<{ purged: number }>`
        select purge_audit_events(${workspaceId}, ${cutoff}, ${limit}) as purged
      `.execute(db);
      return num(result.rows[0]?.purged);
    },
  };

  const telemetry = {
    async overdue(now: Date, days: number): Promise<number> {
      // Day partitions: the day the cut-off falls on, as an ISO date.
      const cutoff = before(now, days * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const result = await sql<{ events: string }>`
        select count(*) as events from telemetry_events where day < ${cutoff}::date
      `.execute(db);
      return num(result.rows[0]?.events);
    },
  };

  const rows: Record<RetentionRowPolicyId, RetentionRowStore> = {
    // Staff call details (B087) whose audit event retention deleted (they sit beside it).
    audit_staff_details: keyedRowStore(
      db,
      'staff_audit_details',
      'audit_id',
      'created_at',
      () =>
        sql`not exists (select 1 from audit_events a where a.id = staff_audit_details.audit_id)`,
    ),
    // Webhook events (B081) created over 30 days ago; their deliveries go with them (cascade).
    webhook_log: keyedRowStore(
      db,
      'webhook_events',
      'id',
      'created_at',
      (now) => sql`created_at < ${before(now, 30 * DAY_MS)}`,
    ),
    // Notifications (B063) created over 90 days ago: the inbox no longer shows them.
    notifications: keyedRowStore(
      db,
      'notifications',
      'id',
      'created_at',
      (now) => sql`created_at < ${before(now, 90 * DAY_MS)}`,
    ),
    // Refresh-token families (B017) past their absolute expiry (180 days).
    refresh_tokens: refreshTokenStore(db),
    // Magic-link tokens (B014) past their expiry (they live 15 minutes and are used once).
    login_tokens: keyedRowStore(
      db,
      'login_tokens',
      'token_hash',
      'expires_at',
      (now) => sql`expires_at < ${now}`,
    ),
    // Device-flow grants (B016) 10 minutes past their expiry, whatever their status.
    device_codes: keyedRowStore(
      db,
      'device_grants',
      'device_code_hash',
      'expires_at',
      (now) => sql`expires_at < ${before(now, 10 * 60 * 1000)}`,
    ),
    // Invites (B029) accepted, revoked or expired over 30 days ago (their key bundles went at
    // once).
    invites: keyedRowStore(
      db,
      'invites',
      'id',
      'created_at',
      (now) =>
        sql`coalesce(accepted_at, revoked_at, expired_at, expires_at) < ${before(now, 30 * DAY_MS)}`,
    ),
    // Account exports (B026) expired (B026's sweep deleted the file) or failed over 30 days ago.
    account_exports: keyedRowStore(db, 'account_exports', 'id', 'created_at', (now) => {
      const cutoff = before(now, 30 * DAY_MS);
      return sql`((status = 'expired' and expires_at < ${cutoff})
        or (status = 'failed' and updated_at < ${cutoff}))`;
    }),
    // Audit exports (B082) expired (B082's sweep deleted the file) or failed over 30 days ago.
    audit_exports: keyedRowStore(db, 'audit_export_jobs', 'id', 'created_at', (now) => {
      const cutoff = before(now, 30 * DAY_MS);
      return sql`((status = 'expired' and expires_at < ${cutoff})
        or (status = 'failed' and coalesce(completed_at, created_at) < ${cutoff}))`;
    }),
    // Stripe events (B072) processed or ignored, received over 90 days ago.
    stripe_events: keyedRowStore(
      db,
      'stripe_event',
      'event_id',
      'received_at',
      (now) =>
        sql`status in ('processed', 'ignored') and received_at < ${before(now, 90 * DAY_MS)}`,
    ),
    // Billing outbox rows (B072) published over 30 days ago.
    billing_outbox: keyedRowStore(
      db,
      'billing_outbox',
      'id',
      'created_at',
      (now) => sql`published_at < ${before(now, 30 * DAY_MS)}`,
    ),
    // Trials (B079) 24 months after they ended (or were recorded, when Stripe gave no end); their
    // owners go with them (cascade).
    billing_trials: keyedRowStore(
      db,
      'billing_trials',
      'stripe_subscription_id',
      'created_at',
      (now) => sql`coalesce(trial_end, created_at) < ${now}::timestamptz - interval '24 months'`,
    ),
    // This job's own run reports, finished over 90 days ago.
    retention_runs: keyedRowStore(
      db,
      'retention_runs',
      'id',
      'started_at',
      (now) => sql`finished_at < ${before(now, 90 * DAY_MS)}`,
    ),
  };

  return { runs, state, history, sessions, audit, telemetry, rows };
}

/** The repository. */
export type RetentionRepository = ReturnType<typeof createRetentionRepository>;
