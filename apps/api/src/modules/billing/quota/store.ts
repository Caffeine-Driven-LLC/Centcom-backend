/**
 * Quota signal state (B076, migration 20260102004500_quota_signal_state.sql): which 80 % and 100 %
 * signals each workspace, limit and period has had, under which limit, and how far their delivery
 * has got.
 *
 * - **Decide** runs in one transaction holding the workspace's signal lock as a transaction lock
 *   (`pg_advisory_xact_lock(76, hashtext(workspace_id))`; the two-key form never meets B030's and
 *   B073's one-key seat lock): an evaluation reads the period's rows, claims new levels (the
 *   primary key makes a level fire at most once; the row keeps the limit it was claimed under) and
 *   re-arms the ones a raised or removed limit put usage below, and all of it commits together.
 * - **Deliver** runs outside any transaction, on one pooled connection holding the same lock as a
 *   session lock (`pg_try_advisory_lock(76, hashtext(workspace_id))`), taken only if it is free.
 *   A delivery or decision of the workspace running at that moment makes it skip; whoever holds
 *   the lock then delivers after it (a decision's evaluation delivers once it commits, and a
 *   decision cannot commit during a delivery), so a signal goes out once and is never left
 *   behind. Each step's mark is its own statement, committed as soon as it runs (`... where
 *   <step> is null`), so a lost connection or a send that waits never undoes the marks of sends
 *   that already went out (Postgres ends a session left idle inside a transaction for 15 s). The
 *   lock is released in `finally`, and goes with the connection if the process dies. A decision
 *   waits for a running delivery, whose sends are bounded (QUOTA_SEND_TIMEOUT_MS each); one that
 *   waits past `statement_timeout` fails and its job retries.
 * - **Sweep candidates:** workspaces whose quota meters moved in the last SWEEP_ACTIVE_DAYS, whose
 *   signals have a delivery step to do, or whose period ended in the last SWEEP_ROLLOVER_MS.
 *
 * Owns: the SQL and the locks. Must not: decide levels (levels.ts and the service do), or call
 * anything outside Postgres.
 */
import type { QuotaSignalsDb } from '@centcom/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { MeteredKey, SignalLevel } from './levels.js';

/** The advisory lock class of quota signals (the card's number). */
export const QUOTA_LOCK_CLASS = 76;
/** Meters that moved this many days ago or less make a workspace a sweep candidate. */
export const SWEEP_ACTIVE_DAYS = 35;
/** A period that ended this recently makes its workspace a sweep candidate (the state rolls over). */
export const SWEEP_ROLLOVER_MS = 2 * 60 * 60 * 1000;

/** Which signal. */
export interface SignalKey {
  workspaceId: string;
  limitKey: MeteredKey;
  periodStart: Date;
  level: SignalLevel;
}

/** A stored signal. */
export interface SignalRow extends SignalKey {
  periodEnd: Date;
  /** When the level was claimed (a re-armed level claimed again gets a new one). */
  claimedAt: Date;
  firedAt: Date | null;
  notifiedAt: Date | null;
  webhookAt: Date | null;
}

/** A level claimed in a period, and the limit it was claimed under. */
export interface ClaimedLevel {
  limitKey: MeteredKey;
  level: SignalLevel;
  limitValue: number;
}

/** What a claim records. */
export interface SignalClaim extends ClaimedLevel {
  periodStart: Date;
  periodEnd: Date;
}

/** The delivery steps, in order: the relay's notice, the owners' notification, the webhook. */
export type DeliveryStep = 'notice' | 'notification' | 'webhook';

/** What a decision can do. */
export interface SignalDecisionTx {
  /** The levels signalled in the period starting `periodStart`. */
  claimed(periodStart: Date): Promise<ClaimedLevel[]>;
  /** Records the signal; false when it was already recorded. */
  claim(row: SignalClaim): Promise<boolean>;
  /** Forgets `levels` of the limit in that period, so they can fire again; how many there were. */
  rearm(limitKey: MeteredKey, periodStart: Date, levels: readonly SignalLevel[]): Promise<number>;
}

/** What a delivery can do; each call commits on its own. */
export interface SignalDeliveryTx {
  /** Signals with a step still to do: oldest period first, `warn` before `reached`. */
  pending(): Promise<SignalRow[]>;
  /** Marks `step` of the signal done at `at`, unless it is already marked (or the row is gone). */
  mark(key: SignalKey, step: DeliveryStep, at: Date): Promise<void>;
}

/** The store. */
export interface QuotaSignalStore {
  /** Runs `fn` in one transaction holding the workspace's signal lock. */
  decide<T>(workspaceId: string, fn: (tx: SignalDecisionTx) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` outside any transaction, holding the workspace's signal lock if it is free;
   * `{ran: false}` (nothing run) when it is not.
   */
  deliver<T>(
    workspaceId: string,
    fn: (tx: SignalDeliveryTx) => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }>;
  /** The highest level signalled per limit in the period starting `periodStart`. */
  levels(workspaceId: string, periodStart: Date): Promise<Partial<Record<MeteredKey, SignalLevel>>>;
  /** Up to `limit` sweep candidates after `after` (null: from the start), by id. */
  sweepCandidates(after: string | null, limit: number, now: Date): Promise<string[]>;
}

const STEP_COLUMN = Object.freeze({
  notice: 'fired_at',
  notification: 'notified_at',
  webhook: 'webhook_at',
} as const satisfies Record<DeliveryStep, string>);

const higher = (a: SignalLevel | undefined, b: SignalLevel): SignalLevel =>
  a === 'reached' || b === 'reached' ? 'reached' : 'warn';

type Db = Kysely<QuotaSignalsDb>;
type Tx = Transaction<QuotaSignalsDb>;

const lock = (trx: Tx, workspaceId: string) =>
  sql`select pg_advisory_xact_lock(${QUOTA_LOCK_CLASS}, hashtext(${workspaceId}))`.execute(trx);

const trySessionLock = async (conn: Db, workspaceId: string): Promise<boolean> => {
  const taken = await sql<{ locked: boolean }>`
    select pg_try_advisory_lock(${QUOTA_LOCK_CLASS}, hashtext(${workspaceId})) as locked
  `.execute(conn);
  return taken.rows[0]?.locked === true;
};

/** Releases the session lock; if that fails, every session lock of the connection (none other). */
async function unlockSession(conn: Db, workspaceId: string): Promise<void> {
  try {
    await sql`select pg_advisory_unlock(${QUOTA_LOCK_CLASS}, hashtext(${workspaceId}))`.execute(
      conn,
    );
  } catch {
    // A broken connection takes its locks with it; a live one must not go back to the pool holding
    // one, or every later delivery of the workspace would skip.
    await sql`select pg_advisory_unlock_all()`.execute(conn).catch(() => undefined);
  }
}

/** The store on Postgres. */
export function createQuotaSignalStore<DB extends QuotaSignalsDb>(
  database: Kysely<DB>,
): QuotaSignalStore {
  const db = database as unknown as Db;
  return {
    decide(workspaceId, fn) {
      return db.transaction().execute(async (trx) => {
        await lock(trx, workspaceId);
        return fn({
          async claimed(periodStart) {
            const rows = await trx
              .selectFrom('quota_signal_state')
              .select(['limit_key', 'level', 'limit_value'])
              .where('workspace_id', '=', workspaceId)
              .where('period_start', '=', periodStart)
              .execute();
            return rows.map((r) => ({
              limitKey: r.limit_key,
              level: r.level,
              limitValue: Number(r.limit_value),
            }));
          },
          async claim(row) {
            const result = await trx
              .insertInto('quota_signal_state')
              .values({
                workspace_id: workspaceId,
                limit_key: row.limitKey,
                period_start: row.periodStart,
                level: row.level,
                period_end: row.periodEnd,
                limit_value: row.limitValue,
              })
              .onConflict((oc) =>
                oc.columns(['workspace_id', 'limit_key', 'period_start', 'level']).doNothing(),
              )
              .executeTakeFirst();
            return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
          },
          async rearm(limitKey, periodStart, levels) {
            if (levels.length === 0) return 0;
            const result = await trx
              .deleteFrom('quota_signal_state')
              .where('workspace_id', '=', workspaceId)
              .where('limit_key', '=', limitKey)
              .where('period_start', '=', periodStart)
              .where('level', 'in', [...levels])
              .executeTakeFirst();
            return Number(result.numDeletedRows);
          },
        });
      });
    },

    deliver(workspaceId, fn) {
      return db.connection().execute(async (conn) => {
        if (!(await trySessionLock(conn, workspaceId))) return { ran: false as const };
        try {
          const value = await fn({
            async pending() {
              const rows = await conn
                .selectFrom('quota_signal_state')
                .selectAll()
                .where('workspace_id', '=', workspaceId)
                .where((eb) =>
                  eb.or([
                    eb('fired_at', 'is', null),
                    eb('notified_at', 'is', null),
                    eb('webhook_at', 'is', null),
                  ]),
                )
                .orderBy('period_start')
                .orderBy(sql`case level when 'warn' then 0 else 1 end`)
                .orderBy('limit_key')
                .execute();
              return rows.map((r) => ({
                workspaceId: r.workspace_id,
                limitKey: r.limit_key,
                periodStart: r.period_start,
                level: r.level,
                periodEnd: r.period_end,
                claimedAt: r.claimed_at,
                firedAt: r.fired_at,
                notifiedAt: r.notified_at,
                webhookAt: r.webhook_at,
              }));
            },
            async mark(key, step, at) {
              const column = STEP_COLUMN[step];
              await conn
                .updateTable('quota_signal_state')
                .set({ [column]: at })
                .where('workspace_id', '=', key.workspaceId)
                .where('limit_key', '=', key.limitKey)
                .where('period_start', '=', key.periodStart)
                .where('level', '=', key.level)
                .where(column, 'is', null)
                .execute();
            },
          });
          return { ran: true as const, value };
        } finally {
          await unlockSession(conn, workspaceId);
        }
      });
    },

    async levels(workspaceId, periodStart) {
      const rows = await db
        .selectFrom('quota_signal_state')
        .select(['limit_key', 'level'])
        .where('workspace_id', '=', workspaceId)
        .where('period_start', '=', periodStart)
        .execute();
      const levels: Partial<Record<MeteredKey, SignalLevel>> = {};
      for (const r of rows) levels[r.limit_key] = higher(levels[r.limit_key], r.level);
      return levels;
    },

    async sweepCandidates(after, limit, now) {
      const active = new Date(now.getTime() - SWEEP_ACTIVE_DAYS * 24 * 60 * 60 * 1000);
      const rolled = new Date(now.getTime() - SWEEP_ROLLOVER_MS);
      const rows = await sql<{ workspace_id: string }>`
        select workspace_id from (
          select workspace_id from usage_counter
          where metric in ('relay.hosted_minutes', 'relay.queue_items') and updated_at >= ${active}
          union
          select workspace_id from quota_signal_state
          where fired_at is null or notified_at is null or webhook_at is null
             or (period_end > ${rolled} and period_end <= ${now})
        ) candidates
        where ${after}::text is null or workspace_id > ${after}
        order by workspace_id
        limit ${limit}
      `.execute(db);
      return rows.rows.map((r) => r.workspace_id);
    },
  };
}
