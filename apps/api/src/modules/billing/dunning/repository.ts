/**
 * Dunning's statements (B078): the `subscription_dunning` rows, and the one write dunning makes to
 * B070's `billing_subscription` (moving `past_due_since` back to the failure's time).
 *
 * - **`apply(ws, decide)`**: under a transaction-scoped advisory lock on the workspace (so two
 *   events, or an event and the expiry job, never interleave), reads the row and the subscription,
 *   writes what `decide` returns and, for a status change, its audit event, in one transaction.
 *   The expiry job drops a workspace to `none` through it too.
 * - The scans (`expiring`, `unannounced`, `remindersDue`) read oldest first, at most `limit`
 *   rows, from the partial indexes.
 *
 * Every statement is parameterised. Owns: this SQL. Must not: decide (machine.ts does), or hold
 * a transaction across anything but this database.
 */
import type { AuditEmitter, AuditEvent } from '@centcom/core';
import type { DunningDb } from '@centcom/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { SubscriptionDunningTable } from '@centcom/db';
import type { DunningAuditAction } from './actions.js';
import type { Decision, DunningRow, ReminderDay, Status, SubscriptionNow } from './machine.js';
import { reminderBit } from './machine.js';

/** B070's subscription, as entitlements take it after dunning moved `past_due_since`. */
export interface AlignedSubscription {
  plan: 'pro' | 'team';
  status: Status;
  periodStart: Date | null;
  periodEnd: Date | null;
  pastDueSince: Date | null;
  seats: number;
}

/** What a change wrote: the decision, and the audit event written with it. */
export type AuditOf = (decision: Decision) => AuditEvent<DunningAuditAction> | null;

/** Dunning's storage. */
export interface DunningRepository {
  /** The workspace's row, or null. */
  find(workspaceId: string): Promise<DunningRow | null>;
  /**
   * Under the workspace's lock: reads the row and the subscription, writes `decide`'s row and
   * `audit`'s event in one transaction; resolves to the decision.
   */
  apply(
    workspaceId: string,
    decide: (row: DunningRow | null, sub: SubscriptionNow | null) => Decision,
    audit: AuditOf,
  ): Promise<Decision>;
  /** Workspaces whose grace or canceled period ended before `now`, oldest end first. */
  expiring(now: Date, limit: number): Promise<string[]>;
  /** Drops (`none`) not announced yet, oldest first. */
  unannounced(limit: number): Promise<DunningRow[]>;
  /** Marks the drop at `noneAt` announced; false when the row moved on. */
  markAnnounced(workspaceId: string, noneAt: Date, at: Date): Promise<boolean>;
  /**
   * `past_due` rows with a reminder due at `now` and not sent, oldest failure first (then by
   * workspace), after `after` when given.
   */
  remindersDue(now: Date, limit: number, after?: DunningRow | null): Promise<DunningRow[]>;
  /** Marks `day` sent for the failure first seen at `firstFailedAt`; false when it moved on. */
  markReminder(workspaceId: string, firstFailedAt: Date, day: ReminderDay): Promise<boolean>;
  /**
   * Moves B070's `past_due_since` back to `at` when the subscription is past due since later; the
   * subscription while it is past due (moved or not), else null.
   */
  alignPastDueSince(workspaceId: string, at: Date): Promise<AlignedSubscription | null>;
}

type Row = Selectable<SubscriptionDunningTable>;

const toRow = (r: Row): DunningRow => ({
  workspaceId: r.workspace_id,
  state: r.state,
  failedInvoice: r.failed_invoice,
  firstFailedAt: r.first_failed_at,
  graceUntil: r.grace_until,
  periodEnd: r.period_end,
  remindersSent: r.reminders_sent,
  noneAt: r.none_at,
  noneReason: r.none_reason,
  announcedAt: r.announced_at,
});

const columns = (row: DunningRow) => ({
  state: row.state,
  failed_invoice: row.failedInvoice,
  first_failed_at: row.firstFailedAt,
  grace_until: row.graceUntil,
  period_end: row.periodEnd,
  reminders_sent: row.remindersSent,
  none_at: row.noneAt,
  none_reason: row.noneReason,
  announced_at: row.announcedAt,
});

/** Takes the workspace's dunning lock for the rest of `trx`. */
async function lock(trx: Transaction<DunningDb>, workspaceId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`subscription_dunning:${workspaceId}`}, 0))`.execute(
    trx,
  );
}

async function readRow(db: Kysely<DunningDb>, workspaceId: string): Promise<DunningRow | null> {
  const r = await db
    .selectFrom('subscription_dunning')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return r === undefined ? null : toRow(r);
}

async function writeRow(trx: Transaction<DunningDb>, row: DunningRow): Promise<void> {
  const values = { ...columns(row), updated_at: sql<Date>`now()` };
  await trx
    .insertInto('subscription_dunning')
    .values({ workspace_id: row.workspaceId, ...values })
    .onConflict((oc) => oc.column('workspace_id').doUpdateSet(values))
    .execute();
}

/** The repository over Postgres; status changes are audited through `audit`. */
export function createDunningRepository(
  db: Kysely<DunningDb>,
  audit: Pick<AuditEmitter<DunningAuditAction>, 'emit'>,
): DunningRepository {
  return {
    find: (workspaceId) => readRow(db, workspaceId),

    apply(workspaceId, decide, auditOf) {
      return db.transaction().execute(async (trx) => {
        await lock(trx, workspaceId);
        const row = await readRow(trx, workspaceId);
        const sub = await trx
          .selectFrom('billing_subscription')
          .select(['status', 'past_due_since', 'period_end'])
          .where('workspace_id', '=', workspaceId)
          .executeTakeFirst();
        const decision = decide(
          row,
          sub === undefined
            ? null
            : { status: sub.status, pastDueSince: sub.past_due_since, periodEnd: sub.period_end },
        );
        if (decision.next !== null) await writeRow(trx, decision.next);
        const event = auditOf(decision);
        if (event !== null) await audit.emit(trx, event);
        return decision;
      });
    },

    async expiring(now, limit) {
      const rows = await db
        .selectFrom('subscription_dunning')
        .select('workspace_id')
        .where((eb) =>
          eb.or([
            eb.and([eb('state', '=', 'past_due'), eb('grace_until', '<', now)]),
            eb.and([eb('state', '=', 'canceled'), eb('period_end', '<', now)]),
          ]),
        )
        .orderBy(sql`coalesce(grace_until, period_end)`)
        .limit(limit)
        .execute();
      return rows.map((r) => r.workspace_id);
    },

    async unannounced(limit) {
      const rows = await db
        .selectFrom('subscription_dunning')
        .selectAll()
        .where('state', '=', 'none')
        .where('announced_at', 'is', null)
        .orderBy('none_at')
        .limit(limit)
        .execute();
      return rows.map(toRow);
    },

    async markAnnounced(workspaceId, noneAt, at) {
      const result = await db
        .updateTable('subscription_dunning')
        .set({ announced_at: at, updated_at: sql<Date>`now()` })
        .where('workspace_id', '=', workspaceId)
        .where('state', '=', 'none')
        .where('none_at', '=', noneAt)
        .where('announced_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async remindersDue(now, limit, after = null) {
      // Day d is due once first_failed_at + d × 24 hours has passed and its bit is still clear
      // (hours, not days: a day interval follows the session time zone's daylight saving).
      const rows = await db
        .selectFrom('subscription_dunning')
        .selectAll()
        .where('state', '=', 'past_due')
        .where((eb) =>
          eb.or(
            ([0, 3, 6] as const).map((day) =>
              eb.and([
                eb(sql`reminders_sent & ${reminderBit(day)}`, '=', 0),
                eb(sql`first_failed_at + make_interval(hours => ${day * 24}::int)`, '<=', now),
              ]),
            ),
          ),
        )
        .where((eb) =>
          after === null || after.firstFailedAt === null
            ? eb.lit(true)
            : eb.or([
                eb('first_failed_at', '>', after.firstFailedAt),
                eb.and([
                  eb('first_failed_at', '=', after.firstFailedAt),
                  eb('workspace_id', '>', after.workspaceId),
                ]),
              ]),
        )
        .orderBy('first_failed_at')
        .orderBy('workspace_id')
        .limit(limit)
        .execute();
      return rows.map(toRow);
    },

    async markReminder(workspaceId, firstFailedAt, day) {
      const bit = reminderBit(day);
      const result = await db
        .updateTable('subscription_dunning')
        .set({
          reminders_sent: sql<number>`reminders_sent | ${bit}`,
          updated_at: sql<Date>`now()`,
        })
        .where('workspace_id', '=', workspaceId)
        .where('state', '=', 'past_due')
        .where('first_failed_at', '=', firstFailedAt)
        .where(sql`reminders_sent & ${bit}`, '=', 0)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async alignPastDueSince(workspaceId, at) {
      const row = await db
        .updateTable('billing_subscription')
        .set({ past_due_since: sql<Date>`least(past_due_since, ${at})` })
        .where('workspace_id', '=', workspaceId)
        .where('status', '=', 'past_due')
        .returning(['plan', 'status', 'period_start', 'period_end', 'past_due_since', 'seats'])
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        plan: row.plan,
        status: row.status,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        pastDueSince: row.past_due_since,
        seats: row.seats,
      };
    },
  };
}
