/**
 * Test helpers for the audit API (B082): an in-memory AuditRepository with the Postgres one's
 * semantics (workspace scope, retention horizon, filters ANDed, newest first by `(created_at, id)`,
 * keyset batches, export state changes only from unfinished states), an in-memory object store
 * that can fail or keep a cut upload, and the routes on the workspaces test stack (request
 * context, errors, idempotency, RBAC, audit).
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  createAuditEmitter,
  paginateArray,
  type AuditActorType,
  type AuditDb,
  type AuditOutcome,
  type Page,
  type PageParams,
} from '@centcom/core';
import type { FastifyInstance } from 'fastify';
import type { CompiledQuery, QueryResult } from 'kysely';
import { AUDIT_API_ACTIONS } from '../../src/modules/audit-api/actions.js';
import {
  ObjectStoreError,
  type LocalFile,
  type ObjectStore,
} from '../../src/modules/audit-api/object-store.js';
import type { AuditRow } from '../../src/modules/audit-api/present.js';
import type {
  AuditRepository,
  BatchKey,
  BatchRow,
  EventScope,
  ExportFailure,
  ExportResult,
  ExportRow,
  NewExport,
} from '../../src/modules/audit-api/repository.js';
import { AuditApiService, DAY_MS } from '../../src/modules/audit-api/service.js';
import { auditRoutes } from '../../src/routes/audit.js';
import {
  asKey,
  asUser,
  createWorkspace,
  KEYS,
  workspacesApp,
  type WorkspacesApp,
} from '../modules/workspaces/helpers.js';

export { asKey, asUser, KEYS };

/** The tests' "now": 2026-10-08 12:00 UTC. */
export const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
export const DAY = DAY_MS;

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

let sequence = 0;

/** An audit row of `workspaceId`; `at` defaults to a second before T0, ids are fresh. */
export function auditRow(
  workspaceId: string,
  over: Partial<Omit<AuditRow, 'workspace_id'>> & { at?: number } = {},
): AuditRow {
  sequence += 1;
  const { at, ...rest } = over;
  return {
    id: newId('aud'),
    workspace_id: workspaceId,
    actor_type: 'user' as AuditActorType,
    actor_id: newId('usr'),
    action: 'member.add',
    target_type: 'membership',
    target_id: newId('mem'),
    outcome: 'success' as AuditOutcome,
    meta: { role: 'member', via: 'invite' },
    created_at: new Date(at ?? T0 - 1000 - sequence),
    ...rest,
  };
}

/** ISO text with microseconds, as Postgres prints a timestamptz (enough for ordering). */
const keyOf = (row: AuditRow): BatchKey => ({ at: row.created_at.toISOString(), id: row.id });

/** Newest first, ties by id descending. */
const newestFirst = (a: AuditRow, b: AuditRow): number => {
  const at = b.created_at.getTime() - a.created_at.getTime();
  return at !== 0 ? at : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/** An in-memory AuditRepository. */
export class MemoryAuditRepository implements AuditRepository {
  events: AuditRow[] = [];
  exports = new Map<string, ExportRow>();
  /** Audit rows written in export transactions. */
  audited: Record<string, unknown>[] = [];
  /** Statements run, by method. */
  calls: string[] = [];
  /** Makes the n-th `batch` call (1-based, counted from now on) throw a connection error. */
  failBatchCall: number | null = null;
  #batchCalls = 0;

  add(...rows: AuditRow[]): void {
    this.events.push(...rows);
  }

  #matching(scope: EventScope): AuditRow[] {
    const { filters } = scope;
    return this.events
      .filter((e) => {
        const t = e.created_at.getTime();
        return (
          e.workspace_id === scope.workspaceId &&
          (scope.since === null || t >= scope.since.getTime()) &&
          (scope.until === undefined || scope.until === null || t <= scope.until.getTime()) &&
          (filters.actor === undefined || e.actor_id === filters.actor) &&
          (filters.action === undefined || e.action === filters.action) &&
          (filters.range?.from === undefined || t >= filters.range.from.getTime()) &&
          (filters.range?.to === undefined || t < filters.range.to.getTime())
        );
      })
      .sort(newestFirst);
  }

  list(scope: EventScope, page: PageParams): Promise<Page<AuditRow>> {
    this.calls.push('list');
    try {
      return Promise.resolve(
        paginateArray(
          this.#matching(scope),
          {
            sorts: { created: { value: (r) => r.created_at.toISOString(), direction: 'desc' } },
            id: (r) => r.id,
          },
          page,
        ),
      );
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }

  countUpTo(scope: EventScope, cap: number): Promise<number> {
    this.calls.push('count');
    return Promise.resolve(Math.min(this.#matching(scope).length, cap + 1));
  }

  batch(scope: EventScope, after: BatchKey | null, limit: number): Promise<BatchRow[]> {
    this.calls.push('batch');
    this.#batchCalls += 1;
    if (this.failBatchCall !== null && this.#batchCalls === this.failBatchCall) {
      return Promise.reject(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
    }
    const rows = this.#matching(scope)
      .filter((r) => {
        if (after === null) return true;
        const key = keyOf(r);
        return key.at < after.at || (key.at === after.at && key.id < after.id);
      })
      .slice(0, limit);
    return Promise.resolve(rows.map((r) => ({ ...r, key: keyOf(r) })));
  }

  async createExport(row: NewExport, audit: (trx: AuditDb) => Promise<unknown>): Promise<void> {
    this.calls.push('createExport');
    const written: Record<string, unknown>[] = [];
    const trx: AuditDb = {
      isTransaction: true,
      executeQuery: <R>(query: CompiledQuery<R>): Promise<QueryResult<R>> => {
        written.push(...auditRows(query));
        return Promise.resolve({ rows: [] });
      },
    };
    await audit(trx);
    // Both or neither: the export only once its audit event is written.
    this.audited.push(...written);
    this.exports.set(row.id, {
      ...row,
      status: 'pending',
      rowCount: null,
      objectKey: null,
      error: null,
      expiresAt: null,
    });
  }

  getExport(workspaceId: string, id: string): Promise<ExportRow | null> {
    const row = this.exports.get(id);
    return Promise.resolve(
      row !== undefined && row.workspaceId === workspaceId ? { ...row } : null,
    );
  }

  start(id: string): Promise<ExportRow | null> {
    const row = this.exports.get(id);
    if (row === undefined || (row.status !== 'pending' && row.status !== 'running')) {
      return Promise.resolve(null);
    }
    row.status = 'running';
    return Promise.resolve({ ...row });
  }

  finish(id: string, result: ExportResult): Promise<boolean> {
    const row = this.exports.get(id);
    if (row?.status !== 'running') return Promise.resolve(false);
    Object.assign(row, {
      status: 'ready',
      rowCount: result.rowCount,
      objectKey: result.objectKey,
      expiresAt: result.expiresAt,
    });
    return Promise.resolve(true);
  }

  fail(id: string, reason: ExportFailure): Promise<boolean> {
    const row = this.exports.get(id);
    if (row === undefined || (row.status !== 'pending' && row.status !== 'running')) {
      return Promise.resolve(false);
    }
    Object.assign(row, { status: 'failed', error: reason });
    return Promise.resolve(true);
  }

  expiring(now: Date, limit: number): Promise<{ id: string; objectKey: string | null }[]> {
    return Promise.resolve(
      [...this.exports.values()]
        .filter((r) => r.status === 'ready' && r.expiresAt !== null && r.expiresAt <= now)
        .slice(0, limit)
        .map((r) => ({ id: r.id, objectKey: r.objectKey })),
    );
  }

  expire(id: string): Promise<void> {
    const row = this.exports.get(id);
    if (row?.status === 'ready') row.status = 'expired';
    return Promise.resolve();
  }

  failStuck(before: Date): Promise<number> {
    let failed = 0;
    for (const row of this.exports.values()) {
      if ((row.status === 'pending' || row.status === 'running') && row.createdAt < before) {
        Object.assign(row, { status: 'failed', error: 'internal' });
        failed += 1;
      }
    }
    return Promise.resolve(failed);
  }

  stalePending(before: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.exports.values()]
        .filter((r) => r.status === 'pending' && r.createdAt < before)
        .slice(0, limit)
        .map((r) => r.id),
    );
  }
}

/** An in-memory object store. */
export class MemoryObjectStore implements ObjectStore {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  /** Every operation fails (the store is unreachable). */
  down = false;
  /** The next `putFile` calls that fail; with `keepCut`, each leaves half its body behind. */
  failPuts = 0;
  keepCut = false;
  puts = 0;

  async putFile(key: string, file: LocalFile): Promise<void> {
    if (this.down) throw new ObjectStoreError('PUT failed');
    const body = await readFile(file.path);
    if (body.length !== file.size) throw new Error('putFile: size mismatch');
    if (createHash('sha256').update(body).digest('hex') !== file.sha256) {
      throw new Error('putFile: digest mismatch');
    }
    this.puts += 1;
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      if (this.keepCut) {
        this.objects.set(key, { body: body.subarray(0, body.length >> 1), contentType: '' });
      }
      throw new ObjectStoreError('PUT failed');
    }
    this.objects.set(key, { body, contentType: file.contentType });
  }

  delete(key: string): Promise<void> {
    if (this.down) return Promise.reject(new ObjectStoreError('DELETE failed'));
    this.objects.delete(key);
    return Promise.resolve();
  }

  presignGet(key: string, ttlS: number, now: Date, opts: { filename?: string } = {}): string {
    const expires = new Date(now.getTime() + ttlS * 1000).toISOString();
    const name = opts.filename === undefined ? '' : `&filename=${opts.filename}`;
    return `https://store.test/${key}?method=GET&ttl=${ttlS}&expires=${expires}${name}`;
  }
}

/** A recording export queue. */
export interface RecordingExportQueue {
  enqueued: string[];
  fail: boolean;
  enqueue(id: string): Promise<void>;
}

/** Options of the test app. */
export interface AuditAppOptions {
  /** `audit_log_days` of every workspace (default 90); override per workspace with `days`. */
  defaultDays?: number;
  maxRows?: number;
  urlTtlS?: number;
}

/** The audit routes on the workspaces test stack. */
export interface AuditApp extends Omit<WorkspacesApp, 'audit'> {
  repo: MemoryAuditRepository;
  objects: MemoryObjectStore;
  exportQueue: RecordingExportQueue;
  audit: AuditApiService;
  /** `audit_log_days` by workspace. */
  days: Map<string, number>;
  /** The service's clock, in milliseconds; tests move it. */
  clock: { now: number };
}

export async function auditApp(opts: AuditAppOptions = {}): Promise<AuditApp> {
  const repo = new MemoryAuditRepository();
  const objects = new MemoryObjectStore();
  const queue: RecordingExportQueue = {
    enqueued: [],
    fail: false,
    enqueue(id) {
      if (queue.fail) return Promise.reject(new Error('redis down'));
      queue.enqueued.push(id);
      return Promise.resolve();
    },
  };
  const days = new Map<string, number>();
  const clock = { now: T0 };
  const pool: AuditDb = {
    isTransaction: false,
    executeQuery: <R>(): Promise<QueryResult<R>> => Promise.resolve({ rows: [] }),
  };
  const audit = new AuditApiService({
    repository: repo,
    retentionDays: (workspaceId) =>
      Promise.resolve(days.get(workspaceId) ?? opts.defaultDays ?? 90),
    emitter: createAuditEmitter({ db: pool, actions: AUDIT_API_ACTIONS, clock: () => clock.now }),
    queue,
    store: objects,
    cursorKeys: KEYS,
    maxRows: opts.maxRows ?? 1_000_000,
    urlTtlS: opts.urlTtlS ?? 900,
    clock: () => clock.now,
  });
  const base = await workspacesApp({
    beforeReady: async (app) => {
      await app.register(auditRoutes, { audit });
    },
  });
  return { ...base, repo, objects, exportQueue: queue, audit, days, clock };
}

/** A workspace owned by a new user, with an admin, a member, a guest and a billing member. */
export async function team(app: AuditApp): Promise<{
  workspace: string;
  owner: string;
  admin: string;
  member: string;
  guest: string;
  billing: string;
}> {
  const owner = app.store.addUser();
  const { id: workspace } = await createWorkspace(app.app, owner);
  const [admin, member, guest, billing] = [newId('usr'), newId('usr'), newId('usr'), newId('usr')];
  app.store.join(workspace, admin, 'admin');
  app.store.join(workspace, member, 'member');
  app.store.join(workspace, guest, 'guest');
  app.store.join(workspace, billing, 'billing');
  return { workspace, owner, admin, member, guest, billing };
}

/** GET the audit list as `headers`. */
export function list(
  app: FastifyInstance,
  workspace: string,
  headers: Record<string, string>,
  query = '',
) {
  return app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspace}/audit${query === '' ? '' : `?${query}`}`,
    headers,
  });
}

/** POST an export request as `headers`. */
export function requestExport(
  app: FastifyInstance,
  workspace: string,
  headers: Record<string, string>,
  payload: unknown = { format: 'csv' },
) {
  return app.inject({
    method: 'POST',
    url: `/v1/workspaces/${workspace}/audit/exports`,
    headers,
    payload: payload as Record<string, unknown>,
  });
}
