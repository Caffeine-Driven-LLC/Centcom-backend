/**
 * Table types of RFC 8628 device grants (B016, migration 20260102000900_device_grants.sql).
 * Written by the device-flow store (apps/api/src/modules/auth/device); only the SHA-256 of the
 * device_code is stored.
 */
import type { ColumnType } from 'kysely';
import type { CreatedAt, NullableTimestamp } from './core.js';
import type { ClientId, TokenDatabase } from './refresh-tokens.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** Where a grant is: waiting, decided by a user, or turned into a device and tokens. */
export type DeviceGrantStatus = 'pending' | 'approved' | 'denied' | 'consumed';

/** Platforms of the `devices` table. */
export type DevicePlatform = 'linux' | 'macos' | 'windows' | 'web' | 'other';

export interface DeviceGrantsTable {
  /** sha256 of the device_code, lower-case hex. */
  device_code_hash: Fixed<string>;
  /** 8 characters of the CT-AUTH alphabet, without the hyphen it is shown with. */
  user_code: Fixed<string>;
  client_id: Fixed<ClientId>;
  /** Space-separated scopes the tokens will carry. */
  scope: Fixed<string>;
  device_name: Fixed<string>;
  platform: Fixed<DevicePlatform>;
  /** 32 bytes, base64url without padding. */
  x25519_pub: Fixed<string>;
  /** 32 bytes, base64url without padding. */
  ed25519_pub: Fixed<string>;
  status: ColumnType<DeviceGrantStatus, DeviceGrantStatus | undefined, DeviceGrantStatus>;
  /** Who approved or denied it; null while pending. */
  user_id: ColumnType<string | null, never, string>;
  /** The device the consuming poll created. */
  device_id: ColumnType<string | null, never, string>;
  interval_s: ColumnType<number, number | undefined, number>;
  last_polled_at: ColumnType<Date | null, never, Date>;
  expires_at: Fixed<Date>;
  decided_at: NullableTimestamp;
  created_at: CreatedAt;
}

/** The device_grants table. */
export interface DeviceGrantsDatabase {
  device_grants: DeviceGrantsTable;
}

/** What the device flow reads and writes: the token tables (devices, refresh tokens) and grants. */
export type DeviceGrantDatabase = TokenDatabase & DeviceGrantsDatabase;
