/**
 * The audit API's SQL (B082): reads of B036's `audit_events` and the `audit_export_jobs` rows.
 *
 * - Every read of `audit_events` is scoped by workspace id and applies the retention horizon
 *   (`created_at >= since`) in SQL, with the filters: `actor_id = $`, `action = $`, `created_at >=
 *   from`, `created_at < to`, ANDed. Newest first by `(created_at, id)`, on B036's
 *   `(workspace_id, created_at, id)` index or this lane's actor and action indexes.
 * - `list` is B025's keyset pagination. `countUpTo` stops counting at `cap + 1`, so asking whether
 *   a range is too big never counts the whole log. `batch` reads one export batch after a keyset
 *   whose time is Postgres's own text (microseconds kept), so no row is skipped or repeated.
 * - Export rows move pending → running → ready → expired, or to failed from pending or running;
 *   `finish` and `fail` change only an unfinished row, so a late retry cannot undo a result.
 *
 * Owns: these statements. Must not: read audit events without a workspace id, or select a column
 * the API does not show (no request ids, no IPs: the table has none).
 */
import { paginate, type AuditDb, type KeysetSpec, type Page, type PageParams } from '@centcom/core';
import { withTransaction, type AuditApiDb, type AuditExportStatus } from '@centcom/db';
import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';
import type { AuditFilters } from './filters.js';
import type { AuditRow } from './present.js';

/** The list's one sort: newest first, ties broken by id. */
export const AUDIT_SORT = 'created';
const LIST_SPEC: KeysetSpec = {
  sorts: { [AUDIT_SORT]: { column: 'created_at', direction: 'desc' } },
  idColumn: 'id',
};

const EVENT_COLUMNS = [
  'id',
  'workspace_id',
  'actor_type',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'outcome',
  'meta',
  'created_at',
] as const;

/** Which events a read covers: a workspace, its filters, and the retention window. */
export interface EventScope {
  workspaceId: string;
  filters: AuditFilters;
  /** Events before this are past retention; null: no horizon. */
  since: Date | null;
  /** Events after this are left out (an export's request time); null: none. */
  until?: Date | null;
}

/** Where an export batch continues: Postgres's text of the last `created_at`, and its id. */
export interface BatchKey {
  at: string;
  id: string;
}

/** An export batch row and its keyset. */
export interface BatchRow extends AuditRow {
  key: BatchKey;
}

/** The filters an export row keeps (JSON), and the horizon it was asked with. */
export interface StoredFilters {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  /** ISO time of the retention horizon. */
  since: string;
}

/** An export job. */
export interface ExportRow {
  id: string;
  workspaceId: string;
  requestedBy: string;
  format: 'csv' | 'json';
  gzip: boolean;
  filters: StoredFilters;
  status: AuditExportStatus;
  rowCount: number | null;
  objectKey: string | null;
  error: ExportFailure | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/** Why an export failed: safe reason codes only. */
export type ExportFailure = 'row_cap_exceeded' | 'storage_unavailable' | 'internal';

/** A new export job. */
export interface NewExport {
  id: string;
  workspaceId: string;
  requestedBy: string;
  format: 'csv' | 'json';
  gzip: boolean;
  filters: StoredFilters;
  createdAt: Date;
}

/** A finished export. */
export interface ExportResult {
  rowCount: number;
  objectKey: string;
  completedAt: Date;
  expiresAt: Date;
}

/** The audit API's persistence. */
export interface AuditRepository {
  /** One page of events, newest first. */
  list(scope: EventScope, page: PageParams): Promise<Page<AuditRow>>;
  /** How many events the scope holds, counting no further than `cap + 1`. */
  countUpTo(scope: EventScope, cap: number): Promise<number>;
  /** Up to `limit` events after `after` (from the newest when null), newest first. */
  batch(scope: EventScope, after: BatchKey | null, limit: number): Promise<BatchRow[]>;
  /** Inserts the export and runs `audit` in the same transaction: both are written, or neither. */
  createExport(row: NewExport, audit: (trx: AuditDb) => Promise<unknown>): Promise<void>;
  /** Workspace `workspaceId`'s export `id`, or null. */
  getExport(workspaceId: string, id: string): Promise<ExportRow | null>;
  /**
   * Marks a pending (or, on a retry, running) export running; returns it, or null when it is
   * finished or there is none.
   */
  start(id: string, now: Date): Promise<ExportRow | null>;
  /** Marks a running export ready; false when it was not running. */
  finish(id: string, result: ExportResult): Promise<boolean>;
  /** Marks an unfinished export failed with `reason`; false when it was finished already. */
  fail(id: string, reason: ExportFailure, now: Date): Promise<boolean>;
  /** Ready exports whose files expire by `now`, oldest first. */
  expiring(now: Date, limit: number): Promise<{ id: string; objectKey: string | null }[]>;
  /** Marks a ready export expired. */
  expire(id: string): Promise<void>;
  /** Ids of exports still pending that were requested before `before`. */
  stalePending(before: Date, limit: number): Promise<string[]>;
  /** Marks exports requested before `before` and still unfinished failed (`internal`); how many. */
  failStuck(before: Date, now: Date): Promise<number>;
}

type Db = Kysely<AuditApiDb>;
type ExportRecord = {
  id: string;
  workspace_id: string;
  requested_by: string;
  format: 'csv' | 'json';
  gzip: boolean;
  filters: Record<string, string>;
  status: AuditExportStatus;
  row_count: number | null;
  object_key: string | null;
  error: string | null;
  created_at: Date;
  expires_at: Date | null;
};

const EXPORT_COLUMNS = [
  'id',
  'workspace_id',
  'requested_by',
  'format',
  'gzip',
  'filters',
  'status',
  'row_count',
  'object_key',
  'error',
  'created_at',
  'expires_at',
] as const;

const FAILURES: ReadonlySet<string> = new Set([
  'row_cap_exceeded',
  'storage_unavailable',
  'internal',
]);

function exportRow(r: ExportRecord): ExportRow {
  const filters = r.filters as Partial<StoredFilters>;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    requestedBy: r.requested_by,
    format: r.format,
    gzip: r.gzip,
    filters: { ...filters, since: filters.since ?? new Date(0).toISOString() },
    status: r.status,
    rowCount: r.row_count,
    objectKey: r.object_key,
    error: r.error !== null && FAILURES.has(r.error) ? (r.error as ExportFailure) : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** The events of `scope`, unordered. */
function scoped(db: Db, scope: EventScope): SelectQueryBuilder<AuditApiDb, 'audit_events', object> {
  const { filters } = scope;
  let query = db.selectFrom('audit_events').where('workspace_id', '=', scope.workspaceId);
  if (scope.since !== null) query = query.where('created_at', '>=', scope.since);
  if (scope.until !== undefined && scope.until !== null) {
    query = query.where('created_at', '<=', scope.until);
  }
  if (filters.actor !== undefined) query = query.where('actor_id', '=', filters.actor);
  if (filters.action !== undefined) query = query.where('action', '=', filters.action);
  if (filters.range?.from !== undefined)
    query = query.where('created_at', '>=', filters.range.from);
  if (filters.range?.to !== undefined) query = query.where('created_at', '<', filters.range.to);
  return query;
}

/** The repository over Postgres. */
export function createAuditRepository(db: Db): AuditRepository {
  return {
    async list(scope, page) {
      const result = await paginate(scoped(db, scope).select(EVENT_COLUMNS), LIST_SPEC, page);
      return result as Page<AuditRow>;
    },

    async countUpTo(scope, cap) {
      const capped = scoped(db, scope)
        .select(sql<number>`1`.as('one'))
        .limit(cap + 1)
        .as('capped');
      const row = await db
        .selectFrom(capped)
        .select(sql<string>`count(*)`.as('n'))
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },

    async batch(scope, after, limit) {
      let query = scoped(db, scope)
        .select(EVENT_COLUMNS)
        .select(sql<string>`created_at::text`.as('key_at'));
      if (after !== null) {
        query = query.where(
          sql<boolean>`(created_at, id) < (${after.at}::timestamptz, ${after.id})`,
        );
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(({ key_at, ...row }) => ({
        ...(row as AuditRow),
        key: { at: key_at, id: row.id },
      }));
    },

    async createExport(row, audit) {
      await withTransaction(db, async (trx) => {
        await trx
          .insertInto('audit_export_jobs')
          .values({
            id: row.id,
            workspace_id: row.workspaceId,
            requested_by: row.requestedBy,
            format: row.format,
            gzip: row.gzip,
            filters: JSON.stringify(row.filters),
            created_at: row.createdAt,
          })
          .execute();
        await audit(trx);
      });
    },

    async getExport(workspaceId, id) {
      const row = await db
        .selectFrom('audit_export_jobs')
        .select(EXPORT_COLUMNS)
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? null : exportRow(row);
    },

    async start(id, now) {
      const row = await db
        .updateTable('audit_export_jobs')
        .set({ status: 'running', started_at: now })
        .where('id', '=', id)
        .where('status', 'in', ['pending', 'running'])
        .returning(EXPORT_COLUMNS)
        .executeTakeFirst();
      return row === undefined ? null : exportRow(row);
    },

    async finish(id, result) {
      const done = await db
        .updateTable('audit_export_jobs')
        .set({
          status: 'ready',
          row_count: result.rowCount,
          object_key: result.objectKey,
          completed_at: result.completedAt,
          expires_at: result.expiresAt,
        })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .executeTakeFirst();
      return Number(done.numUpdatedRows) > 0;
    },

    async fail(id, reason, now) {
      const done = await db
        .updateTable('audit_export_jobs')
        .set({ status: 'failed', error: reason, completed_at: now })
        .where('id', '=', id)
        .where('status', 'in', ['pending', 'running'])
        .executeTakeFirst();
      return Number(done.numUpdatedRows) > 0;
    },

    async expiring(now, limit) {
      const rows = await db
        .selectFrom('audit_export_jobs')
        .select(['id', 'object_key'])
        .where('status', '=', 'ready')
        .where('expires_at', '<=', now)
        .orderBy('expires_at')
        .limit(limit)
        .execute();
      return rows.map((r) => ({ id: r.id, objectKey: r.object_key }));
    },

    async expire(id) {
      await db
        .updateTable('audit_export_jobs')
        .set({ status: 'expired' })
        .where('id', '=', id)
        .where('status', '=', 'ready')
        .execute();
    },

    async stalePending(before, limit) {
      const rows = await db
        .selectFrom('audit_export_jobs')
        .select('id')
        .where('status', '=', 'pending')
        .where('created_at', '<', before)
        .orderBy('created_at')
        .limit(limit)
        .execute();
      return rows.map((r) => r.id);
    },

    async failStuck(before, now) {
      const done = await db
        .updateTable('audit_export_jobs')
        .set({ status: 'failed', error: 'internal', completed_at: now })
        .where('status', 'in', ['pending', 'running'])
        .where('created_at', '<', before)
        .executeTakeFirst();
      return Number(done.numUpdatedRows);
    },
  };
}
