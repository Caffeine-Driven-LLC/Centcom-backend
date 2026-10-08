/**
 * Table types of outgoing webhooks (B081, migration 20260102002300_webhooks.sql). Written by the
 * webhook repository (apps/api `modules/webhooks/repository.ts`); secrets are stored sealed only.
 */
import type { ColumnType, Generated } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';
import type { SealedColumn } from './push-subscriptions.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

export interface WebhookEndpointsTable {
  /** `whk_` id. */
  id: Fixed<string>;
  workspace_id: Fixed<string>;
  url: string;
  events: string[];
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  status: ColumnType<
    'active' | 'failing' | 'disabled',
    'active' | 'failing' | 'disabled' | undefined,
    'active' | 'failing' | 'disabled'
  >;
  secret_enc: ColumnType<SealedColumn, string, string>;
  prev_secret_enc: ColumnType<SealedColumn | null, string | null | undefined, string | null>;
  prev_secret_expires_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  secret_rotated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  failing_since: ColumnType<Date | null, Date | null | undefined, Date | null>;
  disabled_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface WebhookEventsTable {
  id: Fixed<string>;
  workspace_id: Fixed<string>;
  type: Fixed<string>;
  data: ColumnType<Record<string, unknown>, string, never>;
  created_at: Fixed<Date>;
}

export interface WebhookDeliveriesTable {
  /** `dlv_` id: the payload's `id` and `Centcom-Event-Id`. */
  id: Fixed<string>;
  endpoint_id: Fixed<string>;
  event_id: Fixed<string>;
  event_type: Fixed<string>;
  attempt: ColumnType<number, number | undefined, number>;
  status: ColumnType<
    'pending' | 'delivered' | 'failed',
    'pending' | undefined,
    'pending' | 'delivered' | 'failed'
  >;
  http_status: ColumnType<number | null, number | null | undefined, number | null>;
  duration_ms: ColumnType<number | null, number | null | undefined, number | null>;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  response_excerpt: ColumnType<string | null, string | null | undefined, string | null>;
  next_attempt_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface WebhookOutboxTable {
  id: Generated<string>;
  event: ColumnType<Record<string, unknown>, string, never>;
  created_at: CreatedAt;
}

/** The webhook tables. */
export interface WebhookDatabase {
  webhook_endpoints: WebhookEndpointsTable;
  webhook_events: WebhookEventsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  webhook_outbox: WebhookOutboxTable;
}

/** The core tables and webhooks. */
export type WebhookDb = CoreDatabase & WebhookDatabase;
