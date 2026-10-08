/**
 * API-key store (B019): the `api_keys` rows. A key is found for authentication by its peppered
 * hash only; changes run in `transaction(fn)`, where creating locks the workspace row first, so
 * concurrent creates take turns and the workspace's key limit holds. Lists are CT-PAGE keyset
 * pages, newest first.
 *
 * Owns: the SQL of API keys. Must not: return or store a key, or a hash outside `findByHash`.
 */
import { paginate, type AuditDb, type KeysetSpec, type Page, type PageParams } from '@centcom/core';
import { withTransaction, type ApiKeyDatabase, type ApiKeyMode } from '@centcom/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { ApiKeysTable } from '@centcom/db';

/** An API key as callers see it: never the key or its hash. */
export interface ApiKeyRecord {
  /** `key_` id. */
  id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  mode: ApiKeyMode;
  /** The key's first 12 characters. */
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** A key to insert. */
export interface NewApiKey {
  id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  mode: ApiKeyMode;
  /** sha256(pepper ‖ key), hex. */
  keyHash: string;
  prefix: string;
  scopes: readonly string[];
  expiresAt: Date | null;
}

/** A key found for authentication: its hash and whether its workspace is live. */
export interface ApiKeyCredential extends ApiKeyRecord {
  keyHash: string;
  workspaceLive: boolean;
}

/** The operations of one transaction. */
export interface ApiKeyTx {
  /** The transaction itself: audit events written through it commit with the change. */
  readonly trx: AuditDb;
  /** Locks the workspace row until commit; false when it does not exist or is deleted. */
  lockWorkspace(workspaceId: string): Promise<boolean>;
  /** The workspace's keys that work at `now`: not revoked, not expired. */
  countLive(workspaceId: string, now: Date): Promise<number>;
  insert(key: NewApiKey): Promise<ApiKeyRecord>;
  /** The key, its row locked until commit; null when there is none. */
  lock(keyId: string): Promise<ApiKeyRecord | null>;
  /** Marks the key revoked at `at` unless it already is. */
  revoke(keyId: string, at: Date): Promise<void>;
}

/** Whose keys a list shows. */
export type ApiKeyFilter =
  { workspaceId: string; createdBy?: string } | { workspaceId?: undefined; createdBy: string };

/** API-key persistence. */
export interface ApiKeyStore {
  /** Runs `fn` in one transaction (it may run again after a serialization failure). */
  transaction<T>(fn: (tx: ApiKeyTx) => Promise<T>): Promise<T>;
  /** The key, of a live workspace, or null. */
  findById(keyId: string): Promise<ApiKeyRecord | null>;
  /** The key with this hash, for authentication; null when there is none. */
  findByHash(keyHash: string): Promise<ApiKeyCredential | null>;
  /** One page of keys of live workspaces, newest first (sort `created`). */
  list(filter: ApiKeyFilter, params: PageParams): Promise<Page<ApiKeyRecord>>;
  /**
   * Sets `last_used_at` to `now` unless it was set less than `minIntervalMs` before; true when it
   * wrote. The condition is in the statement, so several API processes write once between them.
   */
  touch(keyId: string, now: Date, minIntervalMs: number): Promise<boolean>;
}

/** The sorts of `list`. */
export const API_KEY_LIST_SORTS = ['created'] as const;
const LIST_SPEC: KeysetSpec = {
  sorts: { created: { column: 'api_keys.created_at', direction: 'desc' } },
  idColumn: 'api_keys.id',
};

const COLUMNS = [
  'api_keys.id',
  'api_keys.workspace_id',
  'api_keys.created_by',
  'api_keys.name',
  'api_keys.mode',
  'api_keys.prefix',
  'api_keys.scope',
  'api_keys.created_at',
  'api_keys.last_used_at',
  'api_keys.expires_at',
  'api_keys.revoked_at',
] as const;

type Row = Pick<
  Selectable<ApiKeysTable>,
  | 'id'
  | 'workspace_id'
  | 'created_by'
  | 'name'
  | 'mode'
  | 'prefix'
  | 'scope'
  | 'created_at'
  | 'last_used_at'
  | 'expires_at'
  | 'revoked_at'
>;

const recordOf = (row: Row): ApiKeyRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  createdBy: row.created_by,
  name: row.name,
  mode: row.mode,
  prefix: row.prefix,
  scopes: row.scope.split(' '),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

type Db = Kysely<ApiKeyDatabase> | Transaction<ApiKeyDatabase>;

function operations(trx: Transaction<ApiKeyDatabase>): ApiKeyTx {
  return {
    trx,
    async lockWorkspace(workspaceId) {
      const row = await trx
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', workspaceId)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      return row !== undefined;
    },
    async countLive(workspaceId, now) {
      const { n } = await trx
        .selectFrom('api_keys')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('workspace_id', '=', workspaceId)
        .where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
        .executeTakeFirstOrThrow();
      return Number(n);
    },
    async insert(key) {
      const row = await trx
        .insertInto('api_keys')
        .values({
          id: key.id,
          workspace_id: key.workspaceId,
          created_by: key.createdBy,
          name: key.name,
          mode: key.mode,
          key_hash: key.keyHash,
          prefix: key.prefix,
          scope: key.scopes.join(' '),
          expires_at: key.expiresAt,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return recordOf(row);
    },
    async lock(keyId) {
      const row = await trx
        .selectFrom('api_keys')
        .select(COLUMNS)
        .where('id', '=', keyId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? null : recordOf(row);
    },
    async revoke(keyId, at) {
      await trx
        .updateTable('api_keys')
        .set({ revoked_at: at })
        .where('id', '=', keyId)
        .where('revoked_at', 'is', null)
        .execute();
    },
  };
}

/** Keys of live workspaces. */
const live = (db: Db) =>
  db
    .selectFrom('api_keys')
    .innerJoin('workspaces', 'workspaces.id', 'api_keys.workspace_id')
    .where('workspaces.deleted_at', 'is', null);

/** The store on Postgres (table `api_keys`, migration 20260102001100). */
export function createApiKeyStore(db: Kysely<ApiKeyDatabase>): ApiKeyStore {
  return {
    transaction: (fn) => withTransaction(db, (trx) => fn(operations(trx))),

    async findById(keyId) {
      const row = await live(db)
        .select(COLUMNS)
        .where('api_keys.id', '=', keyId)
        .executeTakeFirst();
      return row === undefined ? null : recordOf(row);
    },

    async findByHash(keyHash) {
      const row = await db
        .selectFrom('api_keys')
        .innerJoin('workspaces', 'workspaces.id', 'api_keys.workspace_id')
        .select([...COLUMNS, 'api_keys.key_hash', 'workspaces.deleted_at'])
        .where('api_keys.key_hash', '=', keyHash)
        .executeTakeFirst();
      if (row === undefined) return null;
      return { ...recordOf(row), keyHash: row.key_hash, workspaceLive: row.deleted_at === null };
    },

    async list(filter, params) {
      let query = live(db).select(COLUMNS);
      if (filter.workspaceId !== undefined) {
        query = query.where('api_keys.workspace_id', '=', filter.workspaceId);
      }
      if (filter.createdBy !== undefined) {
        query = query.where('api_keys.created_by', '=', filter.createdBy);
      }
      const page = await paginate(query, LIST_SPEC, params);
      return { ...page, data: page.data.map(recordOf) };
    },

    async touch(keyId, now, minIntervalMs) {
      const result = await db
        .updateTable('api_keys')
        .set({ last_used_at: now })
        .where('id', '=', keyId)
        .where((eb) =>
          eb.or([
            eb('last_used_at', 'is', null),
            eb('last_used_at', '<=', new Date(now.getTime() - minIntervalMs)),
          ]),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
  };
}
