/**
 * Table types of push subscriptions (B064, migration 20260102001700_push_subscriptions.sql).
 * Written by the push registry (apps/api `modules/notifications/push/registry.ts`); the endpoint or
 * token and the web-push keys are stored sealed only.
 */
import type { ColumnType } from 'kysely';
import type { CoreDatabase, CreatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** A sealed value (core `SealedBody`: iv, data, tag, base64). */
export interface SealedColumn {
  iv: string;
  data: string;
  tag: string;
}

export interface PushSubscriptionsTable {
  /** `psh_` id. */
  id: Fixed<string>;
  user_id: Fixed<string>;
  kind: Fixed<'web_push' | 'apns' | 'fcm'>;
  device_id: Fixed<string | null>;
  /** SHA-256 of the endpoint or token: the de-duplication key. */
  token_hash: Fixed<Buffer>;
  token_enc: Fixed<SealedColumn>;
  keys_enc: Fixed<SealedColumn | null>;
  failures: ColumnType<number, number | undefined, number>;
  failing_since: ColumnType<Date | null, never, Date | null>;
  created_at: CreatedAt;
}

/** The push subscriptions table. */
export interface PushSubscriptionsDatabase {
  push_subscriptions: PushSubscriptionsTable;
}

/** The core tables and the push subscriptions. */
export type PushDatabase = CoreDatabase & PushSubscriptionsDatabase;
