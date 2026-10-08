/**
 * The SQL of usage aggregation (B075): counters, crossings and the aggregator's cursor.
 *
 * - `aggregate` runs the aggregator's step in one transaction that first locks the cursor row, so
 *   runs never overlap, and the counters and the new high-water mark commit together: a crash
 *   leaves both as they were, and the next run redoes the same window.
 * - `eventSums` folds usage_event rows received in (after, upTo] by workspace, type and second of
 *   `at`, so the caller can place each sum in the period it happened in. Raw rows are only read.
 * - `add` adds to counters (`on conflict … total + excluded.total`).
 * - `claimCrossing` marks a threshold crossed for a period unless it already is, and runs `then`
 *   (B069's `bumpRev`) before committing: if `then` throws, the mark is rolled back and the
 *   crossing is tried again later. The row stays locked meanwhile, so concurrent claims wait and
 *   then find it taken.
 *
 * Owns: the statements. Must not: change usage_event rows.
 */
import type { UsageAggregationDb } from '@centcom/db';
import { sql, type Kysely, type Transaction } from 'kysely';

/** Every metric a counter may hold. */
export const COUNTER_METRICS = Object.freeze([
  'agent_minutes',
  'tokens_in',
  'tokens_out',
  'queue_items',
  'relay_bytes',
  'relay.hosted_minutes',
  'relay.queue_items',
  'relay.relay_bytes',
] as const);

/** A counter metric. */
export type CounterMetric = (typeof COUNTER_METRICS)[number];

/** The quota limits B075 meters (CT-ENTITLEMENTS §5: server-measured only). */
export type QuotaKey = 'hosted_minutes_month' | 'queue_items_month';

/** Usage of one workspace, type and second, from usage_event. */
export interface EventSum {
  workspaceId: string;
  type: CounterMetric;
  second: Date;
  total: number;
  events: number;
}

/** An amount to add to a counter. */
export interface CounterDelta {
  workspaceId: string;
  periodStart: Date;
  metric: CounterMetric;
  amount: number;
}

/** A period's crossings of one limit. */
export interface Crossing {
  limitKey: QuotaKey;
  crossed80At: Date | null;
  crossed100At: Date | null;
}

/** What the aggregator does inside its transaction. */
export interface AggregateTx {
  highWater(): Promise<Date>;
  eventSums(after: Date, upTo: Date): Promise<EventSum[]>;
  add(deltas: readonly CounterDelta[]): Promise<void>;
  setHighWater(at: Date): Promise<void>;
}

/** Counter persistence. */
export interface CounterStore {
  /** Runs `fn` in one transaction holding the cursor. */
  aggregate<T>(fn: (tx: AggregateTx) => Promise<T>): Promise<T>;
  /** Adds amounts outside the cursor (the relay's counters). */
  add(deltas: readonly CounterDelta[]): Promise<void>;
  /** The workspace's totals of the period starting `periodStart`, by metric. */
  totals(workspaceId: string, periodStart: Date): Promise<Partial<Record<CounterMetric, number>>>;
  /** The workspace's crossings of the period starting `periodStart`. */
  crossings(workspaceId: string, periodStart: Date): Promise<Crossing[]>;
  /**
   * Marks `limitKey` crossed at `pct` for the period at `at` unless it already is, running `then`
   * in the same transaction; false when it already was. A `then` that throws undoes the mark.
   */
  claimCrossing(
    workspaceId: string,
    periodStart: Date,
    limitKey: QuotaKey,
    pct: 80 | 100,
    at: Date,
    then: () => Promise<void>,
  ): Promise<boolean>;
}

/** The cursor's id for usage_event. */
export const CURSOR_ID = 'usage_event';

/** Sums deltas with the same key, so one statement never touches a row twice. */
export function mergeDeltas(deltas: readonly CounterDelta[]): CounterDelta[] {
  const merged = new Map<string, CounterDelta>();
  for (const d of deltas) {
    const key = `${d.workspaceId}|${d.periodStart.toISOString()}|${d.metric}`;
    const seen = merged.get(key);
    if (seen === undefined) merged.set(key, { ...d });
    else seen.amount += d.amount;
  }
  return [...merged.values()].filter((d) => d.amount > 0);
}

async function addDeltas(
  db: Kysely<UsageAggregationDb> | Transaction<UsageAggregationDb>,
  deltas: readonly CounterDelta[],
): Promise<void> {
  const rows = mergeDeltas(deltas);
  if (rows.length === 0) return;
  await db
    .insertInto('usage_counter')
    .values(
      rows.map((d) => ({
        workspace_id: d.workspaceId,
        period_start: d.periodStart,
        metric: d.metric,
        total: d.amount,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'period_start', 'metric']).doUpdateSet({
        total: sql`usage_counter.total + excluded.total`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

/** The store on Postgres (migration 20260102002200). */
export function createCounterStore<DB extends UsageAggregationDb>(
  database: Kysely<DB>,
): CounterStore {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<UsageAggregationDb>;

  return {
    aggregate(fn) {
      return db.transaction().execute(async (trx) => {
        await trx
          .insertInto('usage_aggregate_cursor')
          .values({ id: CURSOR_ID, high_water: new Date(0) })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
        const cursor = await trx
          .selectFrom('usage_aggregate_cursor')
          .select('high_water')
          .where('id', '=', CURSOR_ID)
          .forUpdate()
          .executeTakeFirstOrThrow();
        return fn({
          highWater: () => Promise.resolve(cursor.high_water),
          async eventSums(after, upTo) {
            const rows = await trx
              .selectFrom('usage_event')
              .select([
                'workspace_id',
                'type',
                sql<Date>`date_trunc('second', at)`.as('second'),
                sql<string>`sum(qty)::text`.as('total'),
                sql<string>`count(*)::text`.as('events'),
              ])
              .where('received_at', '>', after)
              .where('received_at', '<=', upTo)
              .groupBy(['workspace_id', 'type', sql`date_trunc('second', at)`])
              .execute();
            return rows.map((r) => ({
              workspaceId: r.workspace_id,
              type: r.type,
              second: r.second,
              total: Number(r.total),
              events: Number(r.events),
            }));
          },
          add: (deltas) => addDeltas(trx, deltas),
          async setHighWater(at) {
            await trx
              .updateTable('usage_aggregate_cursor')
              .set({ high_water: at, updated_at: new Date() })
              .where('id', '=', CURSOR_ID)
              .execute();
          },
        });
      });
    },

    add: (deltas) => addDeltas(db, deltas),

    async totals(workspaceId, periodStart) {
      const rows = await db
        .selectFrom('usage_counter')
        .select(['metric', 'total'])
        .where('workspace_id', '=', workspaceId)
        .where('period_start', '=', periodStart)
        .execute();
      const out: Partial<Record<CounterMetric, number>> = {};
      for (const r of rows) out[r.metric as CounterMetric] = Number(r.total);
      return out;
    },

    async crossings(workspaceId, periodStart) {
      const rows = await db
        .selectFrom('quota_state')
        .select(['limit_key', 'crossed_80_at', 'crossed_100_at'])
        .where('workspace_id', '=', workspaceId)
        .where('period_start', '=', periodStart)
        .execute();
      return rows.map((r) => ({
        limitKey: r.limit_key,
        crossed80At: r.crossed_80_at,
        crossed100At: r.crossed_100_at,
      }));
    },

    claimCrossing(workspaceId, periodStart, limitKey, pct, at, then) {
      return db.transaction().execute(async (trx) => {
        await trx
          .insertInto('quota_state')
          .values({ workspace_id: workspaceId, period_start: periodStart, limit_key: limitKey })
          .onConflict((oc) => oc.columns(['workspace_id', 'period_start', 'limit_key']).doNothing())
          .execute();
        const column = pct === 80 ? 'crossed_80_at' : 'crossed_100_at';
        const claimed = await trx
          .updateTable('quota_state')
          .set({ [column]: at })
          .where('workspace_id', '=', workspaceId)
          .where('period_start', '=', periodStart)
          .where('limit_key', '=', limitKey)
          .where(column, 'is', null)
          .returning('limit_key')
          .executeTakeFirst();
        if (claimed === undefined) return false;
        await then();
        return true;
      });
    },
  };
}
