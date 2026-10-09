/**
 * Where Stripe webhook events live (B072): `stripe_event`, one row per Stripe event id.
 *
 * - `insert` writes a new event and says whether it was new (`ON CONFLICT DO NOTHING` on the
 *   event id), so a duplicate delivery changes nothing.
 * - `claim` moves an event to `processing` and counts the attempt, in one statement: of two
 *   workers only one claims it. Only `received` and `processing` events are claimed, unless
 *   `force` (a replay) also allows `failed`, `processed` and `ignored` ones.
 * - `finish` records the outcome; `release` records a retryable failure's code and leaves the
 *   event for the next attempt.
 * - `waiting` lists events still not finished, oldest first (the sweep requeues them).
 *
 * Owns: the SQL. Must not: store more of an event than `reduceObject` keeps.
 */
import type { StripeEventStatus, StripeEventsDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

/** An event as processing reads it. */
export interface StoredEvent {
  eventId: string;
  type: string;
  /** When Stripe created the event, Unix seconds (the stale-event guard's clock). */
  created: number;
  /** The reduced object (`reduceObject`). */
  object: Record<string, unknown>;
  status: StripeEventStatus;
  attempts: number;
  lastError: string | null;
}

/** A new event. */
export interface NewEvent {
  eventId: string;
  type: string;
  created: number;
  object: Record<string, unknown>;
  status: 'received' | 'ignored';
}

/** The event store. */
export interface StripeEventStore {
  /** Stores a new event; false when its id is already stored. */
  insert(event: NewEvent): Promise<boolean>;
  get(eventId: string): Promise<StoredEvent | null>;
  /** Marks the event `processing` (+1 attempt) and returns it; null when it is not claimable. */
  claim(eventId: string, opts?: { force?: boolean }): Promise<StoredEvent | null>;
  finish(
    eventId: string,
    status: 'processed' | 'ignored' | 'failed',
    error?: string | null,
  ): Promise<void>;
  /** Records a retryable failure; the event stays claimable. */
  release(eventId: string, error: string): Promise<void>;
  /** Unfinished events received before `before`, oldest first. */
  waiting(before: Date, limit: number): Promise<string[]>;
  /** When the oldest unfinished event was received, or null. */
  oldestWaiting(): Promise<Date | null>;
}

type Row = {
  event_id: string;
  type: string;
  created_at_stripe: Date;
  payload: Record<string, unknown>;
  status: StripeEventStatus;
  attempts: number;
  last_error: string | null;
};

const toEvent = (r: Row): StoredEvent => ({
  eventId: r.event_id,
  type: r.type,
  created: Math.floor(r.created_at_stripe.getTime() / 1000),
  object: r.payload,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
});

const COLUMNS = [
  'event_id',
  'type',
  'created_at_stripe',
  'payload',
  'status',
  'attempts',
  'last_error',
] as const;

/** The event store in Postgres. */
export function createStripeEventStore(db: Kysely<StripeEventsDatabase>): StripeEventStore {
  return {
    async insert(event) {
      const result = await db
        .insertInto('stripe_event')
        .values({
          event_id: event.eventId,
          type: event.type,
          created_at_stripe: new Date(event.created * 1000),
          payload: JSON.stringify(event.object),
          status: event.status,
          ...(event.status === 'ignored' ? { processed_at: sql<Date>`now()` } : {}),
        })
        .onConflict((oc) => oc.column('event_id').doNothing())
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0n) > 0;
    },

    async get(eventId) {
      const row = await db
        .selectFrom('stripe_event')
        .select(COLUMNS)
        .where('event_id', '=', eventId)
        .executeTakeFirst();
      return row === undefined ? null : toEvent(row);
    },

    async claim(eventId, opts = {}) {
      const claimable: StripeEventStatus[] = opts.force
        ? ['received', 'processing', 'failed', 'processed', 'ignored']
        : ['received', 'processing'];
      const row = await db
        .updateTable('stripe_event')
        .set({ status: 'processing', attempts: sql<number>`attempts + 1` })
        .where('event_id', '=', eventId)
        .where('status', 'in', claimable)
        .returning(COLUMNS)
        .executeTakeFirst();
      return row === undefined ? null : toEvent(row);
    },

    async finish(eventId, status, error = null) {
      await db
        .updateTable('stripe_event')
        .set({ status, last_error: error, processed_at: sql<Date>`now()` })
        .where('event_id', '=', eventId)
        .execute();
    },

    async release(eventId, error) {
      await db
        .updateTable('stripe_event')
        .set({ last_error: error })
        .where('event_id', '=', eventId)
        .where('status', '=', 'processing')
        .execute();
    },

    async waiting(before, limit) {
      const rows = await db
        .selectFrom('stripe_event')
        .select('event_id')
        .where('status', 'in', ['received', 'processing'])
        .where('received_at', '<', before)
        .orderBy('received_at')
        .limit(limit)
        .execute();
      return rows.map((r) => r.event_id);
    },

    async oldestWaiting() {
      const row = await db
        .selectFrom('stripe_event')
        .select(sql<Date | null>`min(received_at)`.as('oldest'))
        .where('status', 'in', ['received', 'processing'])
        .executeTakeFirst();
      return row?.oldest ?? null;
    },
  };
}
