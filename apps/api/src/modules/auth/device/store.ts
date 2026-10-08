/**
 * Device grant store (B016): the `device_grants` rows behind the RFC 8628 flow. `insert` records a
 * grant; `findPending` finds the live one behind a user code; `decide` approves or denies it once
 * (compare-and-set on `pending`); `poll` answers a poll with the grant's row locked, and when the
 * grant is approved creates the device, lets the caller issue tokens in the same transaction and
 * marks the grant consumed, so a failed issue leaves no device and no spent grant behind.
 *
 * Owns: the device_grants rows and the devices rows the flow creates. Must not: keep a device_code
 * in clear, let a grant be decided twice or consumed twice, or create a device outside a poll's
 * transaction.
 */
import { newId } from '@centcom/contracts';
import {
  withTransaction,
  type ClientId,
  type DeviceGrantDatabase,
  type DeviceGrantStatus,
  type DevicePlatform,
  type TokenDatabase,
} from '@centcom/db';
import type { Kysely, Selectable } from 'kysely';
import type { DeviceGrantsTable } from '@centcom/db';
import { deviceFingerprint } from './keys.js';

/** Seconds the interval grows by on each `slow_down` (RFC 8628 §3.5). */
export const SLOW_DOWN_STEP_S = 5;
/** The interval never grows past this. */
export const MAX_INTERVAL_S = 60;

/** A grant as stored. */
export interface DeviceGrantRecord {
  deviceCodeHash: string;
  /** Normalised: 8 characters, no hyphen. */
  userCode: string;
  clientId: ClientId;
  scope: string;
  deviceName: string;
  platform: DevicePlatform;
  x25519Pub: string;
  ed25519Pub: string;
  status: DeviceGrantStatus;
  userId: string | null;
  deviceId: string | null;
  intervalS: number;
  lastPolledAt: Date | null;
  expiresAt: Date;
}

/** A grant to record. */
export type NewDeviceGrant = Omit<
  DeviceGrantRecord,
  'status' | 'userId' | 'deviceId' | 'lastPolledAt'
>;

/** What a poll should get, decided from the grant as it stands (pure; see `decidePoll`). */
export type PollDecision = 'expired' | 'denied' | 'slow_down' | 'pending' | 'issue';

/**
 * Decides a poll: an unknown, consumed or expired grant, or one started by another client, is
 * `expired` (one answer, no oracle); a denied one `denied`; an approved one `issue`; a pending one
 * `slow_down` when polled again within its interval, else `pending`.
 */
export function decidePoll(
  grant:
    | Pick<DeviceGrantRecord, 'status' | 'clientId' | 'expiresAt' | 'lastPolledAt' | 'intervalS'>
    | undefined,
  ctx: { now: Date; clientId: string },
): PollDecision {
  if (grant === undefined || grant.status === 'consumed' || grant.clientId !== ctx.clientId) {
    return 'expired';
  }
  if (ctx.now.getTime() >= grant.expiresAt.getTime()) return 'expired';
  if (grant.status === 'denied') return 'denied';
  if (grant.status === 'approved') return 'issue';
  const last = grant.lastPolledAt;
  if (last !== null && ctx.now.getTime() - last.getTime() < grant.intervalS * 1000) {
    return 'slow_down';
  }
  return 'pending';
}

/** The interval after a `slow_down`. */
export const slowerInterval = (intervalS: number): number =>
  Math.min(intervalS + SLOW_DOWN_STEP_S, MAX_INTERVAL_S);

/** The device an approved grant becomes, handed to `issue` with the transaction to issue in. */
export interface ApprovedDevice {
  deviceId: string;
  userId: string;
  clientId: ClientId;
  scope: string;
}

/** What a poll came to. */
export type PollOutcome<T> =
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'slow_down'; intervalS: number }
  | { kind: 'pending'; intervalS: number }
  | { kind: 'issued'; result: T };

/** Where device grants live: Postgres in the API, a fake in tests. */
export interface DeviceGrantStore {
  /** Records a grant; `user_code_taken` when a pending grant already has its user code. */
  insert(grant: NewDeviceGrant): Promise<'inserted' | 'user_code_taken'>;
  /** The pending, unexpired grant with this (normalised) user code. */
  findPending(userCode: string, now: Date): Promise<DeviceGrantRecord | null>;
  /**
   * Approves or denies the pending, unexpired grant with this user code for `userId`; false when
   * there is none (unknown, expired, or already decided).
   */
  decide(
    userCode: string,
    userId: string,
    status: 'approved' | 'denied',
    now: Date,
  ): Promise<boolean>;
  /**
   * Answers a poll for `deviceCodeHash` by `decidePoll`, recording the poll. For `issue` it
   * creates the device and runs `issue` in the same transaction (`tx` is undefined for stores
   * without one); if `issue` throws, nothing changes and the error propagates.
   */
  poll<T>(
    deviceCodeHash: string,
    clientId: string,
    now: Date,
    issue: (device: ApprovedDevice, tx: Kysely<TokenDatabase> | undefined) => Promise<T>,
  ): Promise<PollOutcome<T>>;
}

type Row = Selectable<DeviceGrantsTable>;

const recordOf = (row: Row): DeviceGrantRecord => ({
  deviceCodeHash: row.device_code_hash,
  userCode: row.user_code,
  clientId: row.client_id,
  scope: row.scope,
  deviceName: row.device_name,
  platform: row.platform,
  x25519Pub: row.x25519_pub,
  ed25519Pub: row.ed25519_pub,
  status: row.status,
  userId: row.user_id,
  deviceId: row.device_id,
  intervalS: row.interval_s,
  lastPolledAt: row.last_polled_at,
  expiresAt: row.expires_at,
});

/** SQLSTATE unique_violation. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === UNIQUE_VIOLATION && e.constraint === constraint;
};

/** The store on Postgres (table `device_grants`, migration 20260102000900). */
export function createDeviceGrantStore(db: Kysely<DeviceGrantDatabase>): DeviceGrantStore {
  return {
    async insert(grant) {
      try {
        await db
          .insertInto('device_grants')
          .values({
            device_code_hash: grant.deviceCodeHash,
            user_code: grant.userCode,
            client_id: grant.clientId,
            scope: grant.scope,
            device_name: grant.deviceName,
            platform: grant.platform,
            x25519_pub: grant.x25519Pub,
            ed25519_pub: grant.ed25519Pub,
            interval_s: grant.intervalS,
            expires_at: grant.expiresAt,
          })
          .execute();
        return 'inserted';
      } catch (err) {
        if (isUniqueViolation(err, 'device_grants_user_code_key')) return 'user_code_taken';
        throw err;
      }
    },

    async findPending(userCode, now) {
      const row = await db
        .selectFrom('device_grants')
        .selectAll()
        .where('user_code', '=', userCode)
        .where('status', '=', 'pending')
        .where('expires_at', '>', now)
        .executeTakeFirst();
      return row === undefined ? null : recordOf(row);
    },

    async decide(userCode, userId, status, now) {
      const row = await db
        .updateTable('device_grants')
        .set({ status, user_id: userId, decided_at: now })
        .where('user_code', '=', userCode)
        .where('status', '=', 'pending')
        .where('expires_at', '>', now)
        .returning('device_code_hash')
        .executeTakeFirst();
      return row !== undefined;
    },

    async poll<T>(
      deviceCodeHash: string,
      clientId: string,
      now: Date,
      issue: (device: ApprovedDevice, tx: Kysely<TokenDatabase> | undefined) => Promise<T>,
    ): Promise<PollOutcome<T>> {
      return withTransaction(db, async (trx): Promise<PollOutcome<T>> => {
        // The row lock queues concurrent polls: the first consumes an approved grant, and the
        // rest find it consumed.
        const row = await trx
          .selectFrom('device_grants')
          .selectAll()
          .where('device_code_hash', '=', deviceCodeHash)
          .forUpdate()
          .executeTakeFirst();
        const grant = row === undefined ? undefined : recordOf(row);
        const decision = decidePoll(grant, { now, clientId });
        if (grant === undefined || decision === 'expired') return { kind: 'expired' } as const;
        if (decision === 'denied') return { kind: 'denied' } as const;
        if (decision === 'slow_down' || decision === 'pending') {
          const intervalS =
            decision === 'slow_down' ? slowerInterval(grant.intervalS) : grant.intervalS;
          await trx
            .updateTable('device_grants')
            .set({ interval_s: intervalS, last_polled_at: now })
            .where('device_code_hash', '=', deviceCodeHash)
            .execute();
          return { kind: decision, intervalS };
        }
        const userId = grant.userId as string;
        const deviceId = newId('dev');
        await trx
          .insertInto('devices')
          .values({
            id: deviceId,
            user_id: userId,
            name: grant.deviceName,
            platform: grant.platform,
            x25519_pub: grant.x25519Pub,
            ed25519_pub: grant.ed25519Pub,
            fingerprint: deviceFingerprint({ x25519: grant.x25519Pub, ed25519: grant.ed25519Pub }),
            last_seen_at: now,
          })
          .execute();
        // The token tables are a subset of this database's; Kysely's types cannot narrow it themselves.
        const result = await issue(
          { deviceId, userId, clientId: grant.clientId, scope: grant.scope },
          trx as unknown as Kysely<TokenDatabase>,
        );
        await trx
          .updateTable('device_grants')
          .set({ status: 'consumed', device_id: deviceId, last_polled_at: now })
          .where('device_code_hash', '=', deviceCodeHash)
          .execute();
        return { kind: 'issued', result } as const;
      });
    },
  };
}
