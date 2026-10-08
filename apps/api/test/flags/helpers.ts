/**
 * Test helpers for feature flags (B083): an in-memory FlagRepository with the Postgres one's
 * semantics (one revision, +1 per change, limits checked before the change, the audit write in the
 * change, nothing kept when it fails) that can be taken down, flag definitions, real B017 tokens
 * (user tokens with a plan and workspace, and an API key resolver), and `GET /v1/flags` on the
 * API's plugin stack over a FlagCache, as many instances as a test needs, sharing one in-memory
 * Redis.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  AppError,
  createAuditEmitter,
  createMemoryRedis,
  type AuditDb,
  type RedisBackend,
} from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import type { CompiledQuery, QueryResult } from 'kysely';
import { FLAG_AUDIT_ACTIONS } from '../../src/modules/flags/actions.js';
import { FlagCache } from '../../src/modules/flags/cache.js';
import type { FlagDef } from '../../src/modules/flags/definition.js';
import {
  FlagLimitError,
  flagBytes,
  type ChangeLimits,
  type FlagAudit,
  type FlagRepository,
  type FlagsAtRev,
  type StoredRow,
} from '../../src/modules/flags/repository.js';
import { FlagAdmin, FlagService } from '../../src/modules/flags/service.js';
import { errorHandlerPlugin } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { flagRoutes } from '../../src/routes/flags.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { memoryTokens } from '../modules/auth/tokens/helpers.js';

/** The tests' "now". */
export const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);

/** The rows of an `insert into "audit_events"`, column by column. */
export function auditRows(query: CompiledQuery): Record<string, unknown>[] {
  if (!/insert into "audit_events"/.test(query.sql)) return [];
  const list = /\(([^)]+)\) values/.exec(query.sql)?.[1] ?? '';
  const columns = list.split(', ').map((c) => c.replaceAll('"', ''));
  const rows: Record<string, unknown>[] = [];
  for (let at = 0; at < query.parameters.length; at += columns.length) {
    rows.push(Object.fromEntries(columns.map((c, i) => [c, query.parameters[at + i]])));
  }
  return rows;
}

const bytesOf = (row: StoredRow): number => flagBytes(row.key, row.value, row.default_value);

/** An in-memory FlagRepository. */
export class MemoryFlagRepository implements FlagRepository {
  rows = new Map<string, StoredRow>();
  revision = 0;
  /** Every read and write fails (Postgres down). */
  down = false;
  loads = 0;
  /** Audit rows written by changes. */
  audited: Record<string, unknown>[] = [];

  #check(): void {
    if (this.down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  }

  load(): Promise<FlagsAtRev> {
    try {
      this.#check();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    this.loads += 1;
    return Promise.resolve({
      rev: this.revision,
      rows: [...this.rows.values()].map((r) => structuredClone(r)),
    });
  }

  rev(): Promise<number> {
    try {
      this.#check();
    } catch (err) {
      return Promise.reject(err as Error);
    }
    return Promise.resolve(this.revision);
  }

  /** Stores a row as written straight to the table (for broken definitions); moves the revision. */
  put(row: Partial<StoredRow> & Pick<StoredRow, 'key'>): void {
    this.rows.set(row.key, {
      type: 'bool',
      value: true,
      default_value: false,
      public: false,
      server_only: false,
      kill: false,
      rules: [],
      updated_by: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      updated_at: new Date(T0),
      ...row,
    });
    this.revision += 1;
  }

  async #audit(audit: FlagAudit, previous: StoredRow | null, rev: number): Promise<void> {
    const written: Record<string, unknown>[] = [];
    const trx: AuditDb = {
      isTransaction: true,
      executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
        written.push(...auditRows(query));
        return Promise.resolve({ rows: [] });
      },
    };
    await audit(trx, previous, rev);
    this.audited.push(...written);
  }

  async upsert(
    def: Required<FlagDef>,
    by: string,
    now: Date,
    limits: ChangeLimits,
    audit: FlagAudit,
  ): Promise<{ rev: number; previous: StoredRow | null }> {
    this.#check();
    const previous = this.rows.get(def.key) ?? null;
    if (previous === null && this.rows.size >= limits.maxCount) throw new FlagLimitError('count');
    const row: StoredRow = {
      key: def.key,
      type: def.type,
      value: def.value,
      default_value: def.default,
      public: def.public,
      server_only: def.server_only,
      kill: def.kill,
      rules: def.rules,
      updated_by: by,
      updated_at: now,
    };
    if (!def.server_only) {
      let bytes = bytesOf(row);
      for (const other of this.rows.values()) {
        if (!other.server_only && other.key !== def.key) bytes += bytesOf(other);
      }
      if (bytes > limits.maxBodyBytes) throw new FlagLimitError('body');
    }
    const rev = this.revision + 1;
    // The audit write first: when it fails, nothing changes (one transaction).
    await this.#audit(audit, previous === null ? null : structuredClone(previous), rev);
    this.rows.set(def.key, structuredClone(row));
    this.revision = rev;
    return { rev, previous };
  }

  async remove(
    key: string,
    audit: FlagAudit,
  ): Promise<{ rev: number; previous: StoredRow } | null> {
    this.#check();
    const previous = this.rows.get(key);
    if (previous === undefined) return null;
    const rev = this.revision + 1;
    await this.#audit(audit, structuredClone(previous), rev);
    this.rows.delete(key);
    this.revision = rev;
    return { rev, previous };
  }
}

/** A boolean flag definition. */
export const boolFlag = (key: string, over: Partial<FlagDef> = {}): FlagDef => ({
  key,
  type: 'bool',
  value: true,
  default: false,
  ...over,
});

/** A staff user acting through the admin API. */
export const staff = { kind: 'user' as const, userId: newId('usr'), scopes: ['admin'] };

/** One API process: its cache, service, admin API and app. */
export interface FlagsInstance {
  app: FastifyInstance;
  cache: FlagCache;
  service: FlagService;
  admin: FlagAdmin;
  recorded: ReturnType<typeof recordingMetrics>;
  captured: ReturnType<typeof captureLogger>;
}

/** Shared state of a test: the repository, Redis, the token service, the clock. */
export interface FlagsWorld {
  repo: MemoryFlagRepository;
  redis: RedisBackend;
  clock: { now: number };
  /** Starts another API process on the shared state. */
  instance(opts?: {
    pollMs?: number;
    staleMs?: number;
    ttlS?: number;
    maxCount?: number;
  }): Promise<FlagsInstance>;
  /** A bearer header for a user token. */
  userToken(opts?: {
    userId?: string;
    workspaceId?: string;
    plan?: 'free' | 'pro' | 'team';
    scopes?: string[];
  }): Promise<Record<string, string>>;
  /** A bearer header for an API key of `workspaceId`. */
  apiKey(workspaceId?: string): Record<string, string>;
  close(): Promise<void>;
}

/** A test world; `instance()` starts API processes in it. */
export function flagsWorld(): FlagsWorld {
  const repo = new MemoryFlagRepository();
  const clock = { now: T0 };
  const redis = createMemoryRedis(() => clock.now);
  const plans = new Map<string, 'free' | 'pro' | 'team'>();
  const { tokens } = memoryTokens({
    entitlements: {
      lookup: (userId) => Promise.resolve({ plan: plans.get(userId) ?? 'free', ent: 0 }),
    },
  });
  const keys = new Map<string, string>();
  tokens.registerPrincipalResolver('cen_', (credential) => {
    const workspaceId = keys.get(credential);
    // As B019's resolver: an unknown key is a 401.
    if (workspaceId === undefined) {
      return Promise.reject(new AppError('token_invalid', { detail: 'The API key is not valid.' }));
    }
    return Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId,
      scopes: ['audit:read'],
      keyId: newId('key'),
    });
  });
  const opened: FlagsInstance[] = [];
  const pool: AuditDb = {
    isTransaction: false,
    executeQuery: <R>(): Promise<QueryResult<R>> => Promise.resolve({ rows: [] }),
  };

  return {
    repo,
    redis,
    clock,
    async instance(opts = {}) {
      const captured = captureLogger();
      const recorded = recordingMetrics();
      const cache = new FlagCache({
        repository: repo,
        pubsub: redis.pubsub,
        clock: () => clock.now,
        ...(opts.pollMs === undefined ? {} : { pollMs: opts.pollMs }),
        ...(opts.staleMs === undefined ? {} : { staleMs: opts.staleMs }),
        logger: captured.logger,
        metrics: recorded.metrics,
      });
      await cache.start();
      const service = new FlagService({ cache, config: { ttlS: opts.ttlS ?? 60 } });
      const admin = new FlagAdmin({
        repository: repo,
        emitter: createAuditEmitter({
          db: pool,
          actions: FLAG_AUDIT_ACTIONS,
          clock: () => clock.now,
        }),
        pubsub: redis.pubsub,
        config: { maxCount: opts.maxCount ?? 500, maxValueBytes: 2048 },
        clock: () => clock.now,
        logger: captured.logger,
        metrics: recorded.metrics,
      });
      const app = fastify({ logger: false });
      await app.register(requestContextPlugin, { logger: captured.logger });
      await app.register(errorHandlerPlugin, { logger: captured.logger });
      await app.register(flagRoutes, {
        flags: service,
        authenticate: (credential) => tokens.authenticate(credential),
        clock: () => clock.now,
      });
      await app.ready();
      const instance = { app, cache, service, admin, recorded, captured };
      opened.push(instance);
      return instance;
    },
    async userToken(opts = {}) {
      const userId = opts.userId ?? newId('usr');
      plans.set(userId, opts.plan ?? 'free');
      const issued = await tokens.issueTokens({
        userId,
        deviceId: null,
        scopes: opts.scopes ?? ['profile'],
        ...(opts.workspaceId === undefined ? {} : { workspaceId: opts.workspaceId }),
      });
      return { authorization: `Bearer ${issued.access_token}` };
    },
    apiKey(workspaceId = newId('wsp')) {
      const credential = ['cen', 'test', randomBytes(16).toString('hex')].join('_');
      keys.set(credential, workspaceId);
      return { authorization: `Bearer ${credential}` };
    },
    async close() {
      for (const instance of opened.splice(0)) {
        await instance.cache.stop();
        await instance.app.close();
      }
    },
  };
}

/** GET /v1/flags on `app`. */
export function getFlags(app: FastifyInstance, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/v1/flags', headers });
}

/** Resolves once `check` holds, polling every 5 ms; rejects after `timeoutMs`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<number> {
  const started = performance.now();
  while (!(await check())) {
    if (performance.now() - started > timeoutMs) throw new Error(`not within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return performance.now() - started;
}
