/**
 * Device repository (B020): every read and write of the `devices` table (B008) outside the sign-in
 * flows, and the one `session_members` question devices ask: do two users share a session? Rows
 * come back as `DeviceRecord`, built from an explicit column list.
 *
 * Owns: the SQL. Must not: change a device's public keys (CT-CRYPTO trust on first use: a new key
 * is a new device), check ownership for callers (the devices service does), or open its own
 * transaction.
 */
import { paginate, type Page, type PageParams } from '@centcom/core';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { CoreDatabase, DevicesTable } from '../schema/core.js';

/** A device as the application sees it: exactly these fields. */
export type DeviceRecord = Selectable<DevicesTable>;

/** The columns of `DeviceRecord`: the only ones the repository ever selects. */
export const DEVICE_COLUMNS = [
  'id',
  'user_id',
  'name',
  'platform',
  'x25519_pub',
  'ed25519_pub',
  'fingerprint',
  'last_seen_at',
  'revoked_at',
  'created_at',
] as const satisfies readonly (keyof DeviceRecord)[];

/** What registering a device needs; the database fills the times. */
export interface NewDevice {
  id: string;
  user_id: string;
  name: string;
  platform: DeviceRecord['platform'];
  x25519_pub: string;
  ed25519_pub: string;
  fingerprint: string;
}

/** The sorts of `listForUser`. */
export const DEVICE_LIST_SORTS = ['created'] as const;

/** Reads and writes of devices. */
export interface DeviceRepo {
  insert(device: NewDevice): Promise<DeviceRecord>;
  findById(id: string): Promise<DeviceRecord | null>;
  /** One page of `userId`'s devices, revoked ones included, newest first (sort `created`). */
  listForUser(userId: string, params: PageParams): Promise<Page<DeviceRecord>>;
  /**
   * Sets `revoked_at` when the device is `userId`'s and not revoked yet. True only for the call
   * that revoked it, so a revocation is announced once.
   */
  markRevoked(id: string, userId: string, at: Date): Promise<boolean>;
  /**
   * Sets `last_seen_at` to `at` unless it is already within `minIntervalMs` of it (or the device
   * is revoked or unknown). True when it wrote. One statement, so instances racing write once.
   */
  touch(id: string, at: Date, minIntervalMs: number): Promise<boolean>;
  /** True when both users have a row in `session_members` of one session (left or not). */
  shareSession(userA: string, userB: string): Promise<boolean>;
}

type Db = Kysely<CoreDatabase> | Transaction<CoreDatabase>;

/** The repository over `db` (a pool or a transaction). */
export function createDeviceRepo(db: Db): DeviceRepo {
  return {
    async insert(device) {
      return db
        .insertInto('devices')
        .values(device)
        .returning(DEVICE_COLUMNS)
        .executeTakeFirstOrThrow();
    },

    async findById(id) {
      const row = await db
        .selectFrom('devices')
        .select(DEVICE_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ?? null;
    },

    async listForUser(userId, params) {
      const page = await paginate(
        db.selectFrom('devices').select(DEVICE_COLUMNS).where('user_id', '=', userId),
        {
          sorts: { created: { column: 'devices.created_at', direction: 'desc' } },
          idColumn: 'devices.id',
        },
        params,
      );
      return {
        ...page,
        data: page.data.map((row) => {
          const device = {} as Record<string, unknown>;
          for (const column of DEVICE_COLUMNS) device[column] = row[column];
          return device as DeviceRecord;
        }),
      };
    },

    async markRevoked(id, userId, at) {
      const row = await db
        .updateTable('devices')
        .set({ revoked_at: at })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    },

    async touch(id, at, minIntervalMs) {
      const cutoff = new Date(at.getTime() - minIntervalMs);
      const row = await db
        .updateTable('devices')
        .set({ last_seen_at: at })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<=', cutoff)]))
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    },

    async shareSession(userA, userB) {
      const row = await db
        .selectFrom('session_members as a')
        .innerJoin('session_members as b', 'b.session_id', 'a.session_id')
        .select(sql<number>`1`.as('one'))
        .where('a.user_id', '=', userA)
        .where('b.user_id', '=', userB)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
