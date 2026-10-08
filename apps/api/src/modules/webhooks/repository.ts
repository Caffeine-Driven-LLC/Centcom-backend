/**
 * The SQL of outgoing webhooks (B081): endpoints, events, deliveries and the outbox.
 *
 * - `createEndpoint` counts the workspace's endpoints and inserts in one transaction holding a
 *   per-workspace advisory lock, so concurrent creates cannot pass `webhooks_max`. The caller's
 *   audit write runs in the same transaction.
 * - `fanOut` stores an event and one pending delivery per endpoint, once: an event already stored
 *   (a queue redelivery) writes nothing.
 * - `recordAttempt` is a compare-and-set on the attempt number, so a duplicate or stale job cannot
 *   record twice.
 * - `endpointFailed` dates the run of failures and, once it has lasted the disable period, turns
 *   the endpoint off in a conditional update: exactly one caller sees `disabled`.
 *
 * Owns: the statements. Must not: store a request body, or a secret unsealed.
 */
import { paginate, type AuditDb, type KeysetSpec, type Page, type PageParams } from '@centcom/core';
import type { SealedColumn, WebhookDb } from '@centcom/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { WebhookDeliveriesTable, WebhookEndpointsTable } from '@centcom/db';

/** An endpoint as stored. */
export interface EndpointRecord {
  id: string;
  workspaceId: string;
  url: string;
  events: string[];
  enabled: boolean;
  status: 'active' | 'failing' | 'disabled';
  secretEnc: SealedColumn;
  prevSecretEnc: SealedColumn | null;
  prevSecretExpiresAt: Date | null;
  secretRotatedAt: Date | null;
  failingSince: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A new endpoint. */
export type NewEndpoint = Pick<
  EndpointRecord,
  'id' | 'workspaceId' | 'url' | 'events' | 'secretEnc'
>;

/** Changes to an endpoint. */
export interface EndpointPatch {
  url?: string;
  events?: string[];
  enabled?: boolean;
  /** Re-enabling: back to `active`, the failure run forgotten. */
  reactivate?: boolean;
  /** A rotation: the new secret, and the old one kept until `prevExpiresAt`. */
  rotation?: {
    secretEnc: SealedColumn;
    prevSecretEnc: SealedColumn;
    prevExpiresAt: Date;
    at: Date;
  };
  now: Date;
}

/** A stored event. */
export interface StoredEvent {
  id: string;
  workspaceId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

/** A delivery as stored. */
export interface DeliveryRecord {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed';
  httpStatus: number | null;
  durationMs: number | null;
  lastError: string | null;
  responseExcerpt: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One attempt's result, to record. */
export interface AttemptRecord {
  attempt: number;
  status: 'pending' | 'delivered' | 'failed';
  httpStatus: number | null;
  durationMs: number | null;
  lastError: string | null;
  responseExcerpt: string | null;
  nextAttemptAt: Date | null;
  now: Date;
}

/** Writes a request's audit event in the change's transaction. */
export type AuditStep = (trx: AuditDb) => Promise<unknown>;

/** Webhook persistence. */
export interface WebhookRepository {
  /** Inserts unless the workspace has `limit` endpoints already (null: no limit). */
  createEndpoint(
    row: NewEndpoint,
    limit: number | null,
    audit: AuditStep,
  ): Promise<EndpointRecord | 'limit'>;
  findEndpoint(id: string): Promise<EndpointRecord | null>;
  listEndpoints(workspaceId: string, page: PageParams): Promise<Page<EndpointRecord>>;
  updateEndpoint(
    id: string,
    patch: EndpointPatch,
    audit: AuditStep,
  ): Promise<EndpointRecord | null>;
  deleteEndpoint(id: string, audit: AuditStep): Promise<boolean>;
  /** The workspace's enabled endpoints subscribed to `type` (or `*`). */
  matchingEndpoints(workspaceId: string, type: string): Promise<EndpointRecord[]>;
  /** Stores `event` and its deliveries; false (nothing written) when the event was stored already. */
  fanOut(event: StoredEvent, deliveries: { id: string; endpointId: string }[]): Promise<boolean>;
  findDelivery(
    id: string,
  ): Promise<{ delivery: DeliveryRecord; endpoint: EndpointRecord; event: StoredEvent } | null>;
  /** Records an attempt if the delivery is still at `attempt - 1` and pending; null otherwise. */
  recordAttempt(id: string, result: AttemptRecord): Promise<DeliveryRecord | null>;
  /** Re-opens a delivery for a manual redelivery: pending, next attempt now. */
  reopenDelivery(id: string, now: Date): Promise<DeliveryRecord | null>;
  listDeliveries(endpointId: string, page: PageParams): Promise<Page<DeliveryRecord>>;
  /**
   * A failed attempt: dates the failure run (and marks the endpoint `failing` when `final`); turns
   * the endpoint off when the run began at or before `disableBefore`. `disabled` is true for the
   * one call that turned it off.
   */
  endpointFailed(
    id: string,
    now: Date,
    final: boolean,
    disableBefore: Date,
  ): Promise<{ disabled: boolean }>;
  /** A delivered attempt: the endpoint is healthy again. */
  endpointSucceeded(id: string, now: Date): Promise<void>;
  writeOutbox(event: Record<string, unknown>): Promise<void>;
  /** Passes up to `limit` outbox events, oldest first, to `send`, and deletes them once it resolves. */
  drainOutbox(
    limit: number,
    send: (events: Record<string, unknown>[]) => Promise<void>,
  ): Promise<number>;
}

const ENDPOINT_SPEC: KeysetSpec = {
  sorts: { created: { column: 'created_at', direction: 'desc' } },
  idColumn: 'id',
};
const DELIVERY_SPEC = ENDPOINT_SPEC;

type EndpointRow = Selectable<WebhookEndpointsTable>;
type DeliveryRow = Selectable<WebhookDeliveriesTable>;

const endpointOf = (r: EndpointRow): EndpointRecord => ({
  id: r.id,
  workspaceId: r.workspace_id,
  url: r.url,
  events: r.events,
  enabled: r.enabled,
  status: r.status,
  secretEnc: r.secret_enc,
  prevSecretEnc: r.prev_secret_enc,
  prevSecretExpiresAt: r.prev_secret_expires_at,
  secretRotatedAt: r.secret_rotated_at,
  failingSince: r.failing_since,
  disabledAt: r.disabled_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const deliveryOf = (r: DeliveryRow): DeliveryRecord => ({
  id: r.id,
  endpointId: r.endpoint_id,
  eventId: r.event_id,
  eventType: r.event_type,
  attempt: r.attempt,
  status: r.status,
  httpStatus: r.http_status,
  durationMs: r.duration_ms,
  lastError: r.last_error,
  responseExcerpt: r.response_excerpt,
  nextAttemptAt: r.next_attempt_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The repository on Postgres (migration 20260102002300). */
export function createWebhookRepository<DB extends WebhookDb>(
  database: Kysely<DB>,
): WebhookRepository {
  // Kysely's types are invariant in the database type; only the webhook tables are touched.
  const db = database as unknown as Kysely<WebhookDb>;

  const endpoint = async (q: Kysely<WebhookDb> | Transaction<WebhookDb>, id: string) => {
    const row = await q
      .selectFrom('webhook_endpoints')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : endpointOf(row);
  };

  return {
    createEndpoint(row, limit, audit) {
      return db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`webhooks:${row.workspaceId}`}))`.execute(
          trx,
        );
        if (limit !== null) {
          const counted = await trx
            .selectFrom('webhook_endpoints')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('workspace_id', '=', row.workspaceId)
            .executeTakeFirstOrThrow();
          if (Number(counted.n) >= limit) return 'limit';
        }
        const inserted = await trx
          .insertInto('webhook_endpoints')
          .values({
            id: row.id,
            workspace_id: row.workspaceId,
            url: row.url,
            events: row.events,
            secret_enc: JSON.stringify(row.secretEnc),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await audit(trx);
        return endpointOf(inserted);
      });
    },

    findEndpoint: (id) => endpoint(db, id),

    async listEndpoints(workspaceId, page) {
      const result = await paginate(
        db.selectFrom('webhook_endpoints').selectAll().where('workspace_id', '=', workspaceId),
        ENDPOINT_SPEC,
        page,
      );
      return { ...result, data: result.data.map(endpointOf) };
    },

    updateEndpoint(id, patch, audit) {
      return db.transaction().execute(async (trx) => {
        const set: Record<string, unknown> = { updated_at: patch.now };
        if (patch.url !== undefined) set['url'] = patch.url;
        if (patch.events !== undefined) set['events'] = patch.events;
        if (patch.enabled !== undefined) set['enabled'] = patch.enabled;
        if (patch.reactivate === true) {
          Object.assign(set, { status: 'active', failing_since: null, disabled_at: null });
        }
        if (patch.rotation !== undefined) {
          Object.assign(set, {
            secret_enc: JSON.stringify(patch.rotation.secretEnc),
            prev_secret_enc: JSON.stringify(patch.rotation.prevSecretEnc),
            prev_secret_expires_at: patch.rotation.prevExpiresAt,
            secret_rotated_at: patch.rotation.at,
          });
        }
        const updated = await trx
          .updateTable('webhook_endpoints')
          .set(set)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();
        if (updated === undefined) return null;
        await audit(trx);
        return endpointOf(updated);
      });
    },

    deleteEndpoint(id, audit) {
      return db.transaction().execute(async (trx) => {
        const deleted = await trx
          .deleteFrom('webhook_endpoints')
          .where('id', '=', id)
          .returning('id')
          .executeTakeFirst();
        if (deleted === undefined) return false;
        await audit(trx);
        return true;
      });
    },

    async matchingEndpoints(workspaceId, type) {
      const rows = await db
        .selectFrom('webhook_endpoints')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('enabled', '=', true)
        .where(sql<boolean>`(${type} = any(events) or '*' = any(events))`)
        .execute();
      return rows.map(endpointOf);
    },

    fanOut(event, deliveries) {
      return db.transaction().execute(async (trx) => {
        const stored = await trx
          .insertInto('webhook_events')
          .values({
            id: event.id,
            workspace_id: event.workspaceId,
            type: event.type,
            data: JSON.stringify(event.data),
            created_at: event.createdAt,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (stored === undefined) return false;
        if (deliveries.length > 0) {
          await trx
            .insertInto('webhook_deliveries')
            .values(
              deliveries.map((d) => ({
                id: d.id,
                endpoint_id: d.endpointId,
                event_id: event.id,
                event_type: event.type,
              })),
            )
            .execute();
        }
        return true;
      });
    },

    async findDelivery(id) {
      const delivery = await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (delivery === undefined) return null;
      const [owner, event] = await Promise.all([
        endpoint(db, delivery.endpoint_id),
        db
          .selectFrom('webhook_events')
          .selectAll()
          .where('id', '=', delivery.event_id)
          .executeTakeFirst(),
      ]);
      if (owner === null || event === undefined) return null;
      return {
        delivery: deliveryOf(delivery),
        endpoint: owner,
        event: {
          id: event.id,
          workspaceId: event.workspace_id,
          type: event.type,
          data: event.data,
          createdAt: event.created_at,
        },
      };
    },

    async recordAttempt(id, r) {
      const row = await db
        .updateTable('webhook_deliveries')
        .set({
          attempt: r.attempt,
          status: r.status,
          http_status: r.httpStatus,
          duration_ms: r.durationMs,
          last_error: r.lastError,
          response_excerpt: r.responseExcerpt,
          next_attempt_at: r.nextAttemptAt,
          updated_at: r.now,
        })
        .where('id', '=', id)
        .where('attempt', '=', r.attempt - 1)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : deliveryOf(row);
    },

    async reopenDelivery(id, now) {
      const row = await db
        .updateTable('webhook_deliveries')
        .set({ status: 'pending', next_attempt_at: now, updated_at: now })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? null : deliveryOf(row);
    },

    async listDeliveries(endpointId, page) {
      const result = await paginate(
        db.selectFrom('webhook_deliveries').selectAll().where('endpoint_id', '=', endpointId),
        DELIVERY_SPEC,
        page,
      );
      return { ...result, data: result.data.map(deliveryOf) };
    },

    async endpointFailed(id, now, final, disableBefore) {
      await db
        .updateTable('webhook_endpoints')
        .set({
          failing_since: sql`coalesce(failing_since, ${now})`,
          ...(final ? { status: sql`case when enabled then 'failing' else status end` } : {}),
          updated_at: now,
        })
        .where('id', '=', id)
        .execute();
      const disabled = await db
        .updateTable('webhook_endpoints')
        .set({ enabled: false, status: 'disabled', disabled_at: now, updated_at: now })
        .where('id', '=', id)
        .where('enabled', '=', true)
        .where('failing_since', '<=', disableBefore)
        .returning('id')
        .executeTakeFirst();
      return { disabled: disabled !== undefined };
    },

    async endpointSucceeded(id, now) {
      await db
        .updateTable('webhook_endpoints')
        .set({ failing_since: null, status: 'active', updated_at: now })
        .where('id', '=', id)
        .where('enabled', '=', true)
        .execute();
    },

    async writeOutbox(event) {
      await db
        .insertInto('webhook_outbox')
        .values({ event: JSON.stringify(event) })
        .execute();
    },

    drainOutbox(limit, send) {
      return db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('webhook_outbox')
          .select(['id', 'event'])
          .orderBy('id')
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();
        if (rows.length === 0) return 0;
        await send(rows.map((r) => r.event));
        await trx
          .deleteFrom('webhook_outbox')
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
        return rows.length;
      });
    },
  };
}
