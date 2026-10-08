/**
 * Test helpers for API keys (B019): an in-memory ApiKeyStore with the Postgres store's semantics
 * (its transactions are the workspace store's, so they run one at a time, roll back on a throw and
 * keep their audit rows only on commit; only live workspaces' keys are found or listed), the
 * routes on B027's plugin stack (callers named by headers), and an app where callers present real
 * keys as bearers (auth plugin, token service, the authenticator, RBAC from the principal).
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  createAuditEmitter,
  createAuthorizer,
  paginateArray,
  rbacAuditSink,
  Secret,
  type AuditDb,
  type Metrics,
  type WorkspaceRole,
} from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import type { QueryResult } from 'kysely';
import {
  createApiKeyAuthenticator,
  principalActor,
  registerApiKeyAuthenticator,
  type ApiKeyAuthenticator,
} from '../../../src/modules/apikeys/authenticator.js';
import type {
  ApiKeyCredential,
  ApiKeyRecord,
  ApiKeyStore,
  ApiKeyTx,
} from '../../../src/modules/apikeys/repo.js';
import { ApiKeyService, type ApiKeyLimits } from '../../../src/modules/apikeys/service.js';
import { auditPlugin } from '../../../src/plugins/audit.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { errorHandlerPlugin } from '../../../src/plugins/error-handler.js';
import { idempotencyPlugin } from '../../../src/plugins/idempotency.js';
import { rbacPlugin, requirePermission } from '../../../src/plugins/rbac.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import { apiKeyRoutes } from '../../../src/routes/api-keys.js';
import { captureLogger } from '../../helpers.js';
import { memoryTokens } from '../auth/tokens/helpers.js';
import {
  buildWorkspacesApp,
  KEYS,
  MemoryWorkspaceStore,
  type WorkspacesApp,
} from '../workspaces/helpers.js';

export { asKey, asUser, KEYS } from '../workspaces/helpers.js';

/** The pepper of the tests (32 bytes). */
export const PEPPER = new Secret('test-pepper-0123456789abcdefghijklmnop');

/** A stored key: the record plus what only the store sees. */
export interface MemoryKey extends ApiKeyRecord {
  keyHash: string;
}

/** API keys in memory, over a MemoryWorkspaceStore (for its workspaces and transactions). */
export class MemoryApiKeyStore implements ApiKeyStore {
  keys = new Map<string, MemoryKey>();
  /** Fails the next `touch` calls while positive. */
  failTouches = 0;
  touches = 0;

  constructor(readonly ws: MemoryWorkspaceStore) {}

  #live(workspaceId: string): boolean {
    return this.ws.workspaces.get(workspaceId)?.deletedAt === null;
  }

  #record(key: MemoryKey): ApiKeyRecord {
    const record: Partial<MemoryKey> = { ...key, scopes: [...key.scopes] };
    delete record.keyHash;
    return record as ApiKeyRecord;
  }

  transaction<T>(fn: (tx: ApiKeyTx) => Promise<T>): Promise<T> {
    return this.ws.exclusive(async (trx: AuditDb) => {
      const saved = new Map([...this.keys].map(([k, v]) => [k, { ...v }]));
      try {
        return await fn(this.#tx(trx));
      } catch (err) {
        this.keys = saved;
        throw err;
      }
    });
  }

  #tx(trx: AuditDb): ApiKeyTx {
    return {
      trx,
      lockWorkspace: (workspaceId) => Promise.resolve(this.#live(workspaceId)),
      countLive: (workspaceId, now) =>
        Promise.resolve(
          [...this.keys.values()].filter(
            (k) =>
              k.workspaceId === workspaceId &&
              k.revokedAt === null &&
              (k.expiresAt === null || k.expiresAt.getTime() > now.getTime()),
          ).length,
        ),
      insert: (key) => {
        if ([...this.keys.values()].some((k) => k.keyHash === key.keyHash)) {
          return Promise.reject(new Error('duplicate key hash'));
        }
        const row: MemoryKey = {
          id: key.id,
          workspaceId: key.workspaceId,
          createdBy: key.createdBy,
          name: key.name,
          mode: key.mode,
          prefix: key.prefix,
          scopes: [...key.scopes],
          createdAt: new Date(this.ws.now++),
          lastUsedAt: null,
          expiresAt: key.expiresAt,
          revokedAt: null,
          keyHash: key.keyHash,
        };
        this.keys.set(row.id, row);
        return Promise.resolve(this.#record(row));
      },
      lock: (keyId) => {
        const key = this.keys.get(keyId);
        return Promise.resolve(key === undefined ? null : this.#record(key));
      },
      revoke: (keyId, at) => {
        const key = this.keys.get(keyId);
        if (key !== undefined && key.revokedAt === null) key.revokedAt = at;
        return Promise.resolve();
      },
    };
  }

  findById(keyId: string): Promise<ApiKeyRecord | null> {
    const key = this.keys.get(keyId);
    return Promise.resolve(
      key === undefined || !this.#live(key.workspaceId) ? null : this.#record(key),
    );
  }

  findByHash(keyHash: string): Promise<ApiKeyCredential | null> {
    const key = [...this.keys.values()].find((k) => k.keyHash === keyHash);
    return Promise.resolve(
      key === undefined
        ? null
        : {
            ...this.#record(key),
            keyHash: key.keyHash,
            workspaceLive: this.#live(key.workspaceId),
          },
    );
  }

  list(
    filter: { workspaceId?: string; createdBy?: string },
    params: Parameters<ApiKeyStore['list']>[1],
  ): ReturnType<ApiKeyStore['list']> {
    const items = [...this.keys.values()]
      .filter((k) => this.#live(k.workspaceId))
      .filter((k) => filter.workspaceId === undefined || k.workspaceId === filter.workspaceId)
      .filter((k) => filter.createdBy === undefined || k.createdBy === filter.createdBy)
      .map((k) => this.#record(k));
    return Promise.resolve(
      paginateArray(
        items,
        {
          sorts: { created: { value: (k) => k.createdAt.toISOString(), direction: 'desc' } },
          id: (k) => k.id,
        },
        params,
      ),
    );
  }

  touch(keyId: string, now: Date, minIntervalMs: number): Promise<boolean> {
    if (this.failTouches > 0) {
      this.failTouches--;
      return Promise.reject(new Error('database is busy'));
    }
    const key = this.keys.get(keyId);
    if (
      key === undefined ||
      (key.lastUsedAt !== null && key.lastUsedAt.getTime() > now.getTime() - minIntervalMs)
    ) {
      return Promise.resolve(false);
    }
    key.lastUsedAt = now;
    this.touches++;
    return Promise.resolve(true);
  }
}

/** A workspace with an owner, and members in the other roles, in `ws`. */
export function arrangeWorkspace(ws: MemoryWorkspaceStore): {
  workspaceId: string;
  users: Record<WorkspaceRole, string>;
} {
  const users = {
    owner: ws.addUser(),
    admin: ws.addUser(),
    member: ws.addUser(),
    billing: ws.addUser(),
    guest: ws.addUser(),
  };
  const workspaceId = newId('wsp');
  ws.workspaces.set(workspaceId, {
    id: workspaceId,
    name: 'Acme',
    slug: `acme-${randomBytes(4).toString('hex')}`,
    version: 1,
    createdAt: new Date(ws.now),
    createdBy: users.owner,
    deletedAt: null,
  });
  for (const [role, userId] of Object.entries(users)) {
    ws.join(workspaceId, userId, role as WorkspaceRole);
  }
  return { workspaceId, users };
}

/** Limits that answer `max` for every workspace. */
export const limitsOf = (max: number | null): ApiKeyLimits => ({
  apiKeysMax: () => Promise.resolve(max),
});

/** The routes on B027's stack (callers by test headers), with a fresh in-memory store. */
export async function apiKeysApp(
  opts: { limit?: number | null; clock?: () => number } = {},
): Promise<WorkspacesApp & { keys: MemoryApiKeyStore; apiKeys: ApiKeyService }> {
  const ws = new MemoryWorkspaceStore();
  const keys = new MemoryApiKeyStore(ws);
  const apiKeys = new ApiKeyService({
    store: keys,
    pepper: PEPPER,
    limits: limitsOf(opts.limit === undefined ? 5 : opts.limit),
    ...(opts.clock === undefined ? {} : { now: opts.clock }),
  });
  const built = await buildWorkspacesApp(ws, ws.reader, {
    beforeReady: async (app) => {
      await app.register(apiKeyRoutes, {
        service: apiKeys,
        cursorKeys: KEYS,
        ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      });
    },
  });
  return { ...built, keys, apiKeys };
}

/** An app where callers present real keys (and access tokens) as bearers. */
export interface BearerApp {
  app: FastifyInstance;
  ws: MemoryWorkspaceStore;
  keys: MemoryApiKeyStore;
  service: ApiKeyService;
  authenticator: ApiKeyAuthenticator;
  tokens: ReturnType<typeof memoryTokens>;
  logs: () => string;
  /** An access token for `userId` with `scopes`. */
  userToken(userId: string, scopes?: string): Promise<string>;
}

/**
 * The auth plugin with the token service and the key authenticator, RBAC from the principal,
 * audit, idempotency and the key routes; plus `/v1/test/whoami` (the principal) and
 * `/v1/test/sessions/:id/join-token` (guarded like the sessions lane's join, `session.join.editor`).
 */
export async function bearerApp(
  opts: { metrics?: Metrics; now?: () => number } = {},
): Promise<BearerApp> {
  const ws = new MemoryWorkspaceStore();
  const keys = new MemoryApiKeyStore(ws);
  const tokens = memoryTokens();
  const now = opts.now ?? tokens.clock.now;
  const captured = captureLogger();
  const service = new ApiKeyService({ store: keys, pepper: PEPPER, limits: limitsOf(10), now });
  const authenticator = createApiKeyAuthenticator({
    store: keys,
    pepper: PEPPER,
    now,
    logger: captured.logger,
    ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }),
  });
  registerApiKeyAuthenticator(tokens.tokens, authenticator);
  const detached: Record<string, unknown>[] = [];
  const pool: AuditDb = {
    isTransaction: false,
    executeQuery: <R>(): Promise<QueryResult<R>> => {
      detached.push({});
      return Promise.resolve({ rows: [] });
    },
  };
  const emitter = createAuditEmitter({ db: pool, logger: captured.logger });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens: tokens.tokens });
  await app.register(idempotencyPlugin, {
    kv: tokens.redis.kv,
    encryptionKey: new Secret(new Uint8Array(randomBytes(32))),
    principal: (request) => request.principal?.keyId ?? request.principal?.userId ?? null,
  });
  await app.register(rbacPlugin, {
    authorizer: createAuthorizer({ memberships: ws.reader, audit: rbacAuditSink(emitter) }),
    actor: (request) => principalActor(request.principal),
  });
  await app.register(auditPlugin, { emitter });
  await app.register(apiKeyRoutes, { service, cursorKeys: KEYS, clock: now });
  app.get('/v1/test/whoami', async (request) => {
    const p = request.principal;
    return p === null
      ? null
      : { kind: p.kind, keyId: p.keyId, workspaceId: p.workspaceId, scopes: p.scopes };
  });
  app.post(
    '/v1/test/sessions/:id/join-token',
    {
      preHandler: requirePermission('session.join.editor', (request) => ({
        sessionId: String((request.params as Record<string, unknown>)['id']),
      })),
    },
    async () => ({ ticket: 'never' }),
  );
  await app.ready();
  return {
    app,
    ws,
    keys,
    service,
    authenticator,
    tokens,
    logs: captured.raw,
    async userToken(userId, scopes = 'profile workspaces:read workspaces:write') {
      const issued = await tokens.tokens.issueTokens({
        userId,
        deviceId: null,
        scopes: scopes.split(' '),
      });
      return issued.access_token;
    },
  };
}

/** The bearer header of a credential. */
export const bearer = (credential: string): Record<string, string> => ({
  authorization: `Bearer ${credential}`,
});

/** The rows of an audit `insert`, to read meta from (unused queries ignored). */
export const auditActions = (ws: MemoryWorkspaceStore): string[] =>
  ws.audit.map((row) => String(row['action']));
