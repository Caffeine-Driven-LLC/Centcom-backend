/**
 * Telemetry's SQL (B085): the day-partitioned `telemetry_events`, the daily rollups and the
 * retention of partitions.
 *
 * - `insert` writes a batch in one INSERT, in a transaction whose statement timeout is 1 s, so a
 *   slow database sheds telemetry instead of queueing requests. A batch for a day without a
 *   partition creates it (`telemetry_ensure_partition`) and tries once more.
 * - `rollup` claims the day in `telemetry_rollups` and writes its counts in the same transaction:
 *   a day is rolled up exactly once, however often it is asked.
 * - `drop` removes the day tables older than a day (`telemetry_drop_partitions`).
 *
 * Owns: these statements. Must not: write a column that could identify a person.
 */
import type { TelemetryDatabase } from '@centcom/db';
import { withTransaction } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import type { StoredEvent } from './scrub.js';

/** The statement timeout of an insert. */
export const INSERT_TIMEOUT_MS = 1000;
/** SQLSTATE of "no partition of relation found for row". */
const NO_PARTITION = '23514';

/** `YYYY-MM-DD` of a UTC day. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** Telemetry's persistence. */
export interface TelemetryRepository {
  /** Writes the events received on `day` in one statement. */
  insert(day: string, events: readonly StoredEvent[]): Promise<void>;
  /** Rolls `day` up into `telemetry_daily_agg` unless it was; true when this call did it. */
  rollup(day: string): Promise<boolean>;
  /** The days that have a partition, oldest first. */
  partitionDays(): Promise<string[]>;
  /** The days rolled up already. */
  rolledUpDays(): Promise<string[]>;
  /** Drops the partitions of days before `before`; returns their table names. */
  drop(before: string): Promise<string[]>;
}

/** The repository over Postgres. */
export function createTelemetryRepository(db: Kysely<TelemetryDatabase>): TelemetryRepository {
  const insertOnce = (day: string, events: readonly StoredEvent[]) =>
    withTransaction(db, async (trx) => {
      await sql`select set_config('statement_timeout', ${String(INSERT_TIMEOUT_MS)}, true)`.execute(
        trx,
      );
      await trx
        .insertInto('telemetry_events')
        .values(
          events.map((e) => ({
            day,
            install_id: e.install_id,
            type: e.type,
            at: e.at,
            props: JSON.stringify(e.props),
          })),
        )
        .execute();
    });

  return {
    async insert(day, events) {
      if (events.length === 0) return;
      try {
        await insertOnce(day, events);
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== NO_PARTITION) throw err;
        await sql`select telemetry_ensure_partition(${day}::date)`.execute(db);
        await insertOnce(day, events);
      }
    },

    rollup(day) {
      return withTransaction(db, async (trx) => {
        const claimed = await trx
          .insertInto('telemetry_rollups')
          .values({ day })
          .onConflict((oc) => oc.column('day').doNothing())
          .returning('day')
          .executeTakeFirst();
        if (claimed === undefined) return false;
        await sql`
          insert into telemetry_daily_agg (day, type, key, count)
          select day, type, '*', count(*) from telemetry_events where day = ${day}::date group by day, type
          union all
          select e.day, e.type, p.key || '=' || (p.value #>> '{}'), count(*)
          from telemetry_events e cross join lateral jsonb_each(e.props) as p(key, value)
          where e.day = ${day}::date and jsonb_typeof(p.value) in ('string', 'boolean')
          group by e.day, e.type, p.key, p.value #>> '{}'
          on conflict (day, type, key) do nothing
        `.execute(trx);
        return true;
      });
    },

    async partitionDays() {
      const { rows } = await sql<{ relname: string }>`
        select c.relname
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
        where p.relname = 'telemetry_events' and c.relname ~ '^telemetry_events_[0-9]{8}$'
        order by c.relname
      `.execute(db);
      return rows.map((r) => {
        const d = r.relname.slice('telemetry_events_'.length);
        return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      });
    },

    async rolledUpDays() {
      const rows = await db
        .selectFrom('telemetry_rollups')
        .select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'))
        .execute();
      return rows.map((r) => r.day);
    },

    async drop(before) {
      const { rows } = await sql<{ name: string }>`
        select telemetry_drop_partitions(${before}::date) as name
      `.execute(db);
      return rows.map((r) => r.name);
    },
  };
}
