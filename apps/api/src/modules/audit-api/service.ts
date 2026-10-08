/**
 * The audit API (B082, CT-API-AUDIT): a workspace's audit log, newest first with filters, and
 * asynchronous CSV or JSON exports of it.
 *
 * - **Retention:** only events from the last `audit_log_days` days of the workspace's plan are
 *   visible (the horizon is in the SQL). `audit_log_days = 0` means the plan has no audit log:
 *   the list and new exports are 403 `entitlement_required`.
 * - **List:** CT-PAGE, cursors bound to the workspace and filters (B025: signed, 24 h). Reading
 *   writes no audit event.
 * - **Exports:** a request counts the matching events first, stopping at the cap: more than
 *   AUDIT_EXPORT_MAX_ROWS is 422 at `/from` (narrow the range). Otherwise the export row and its
 *   `audit.export` event are written in one transaction, and the job is queued (`audit-export`);
 *   when queueing fails the export stays pending and the worker's sweep queues it later. The
 *   export covers the events up to the request's time, so a retried job writes the same file.
 * - **Status:** `running` shows as `pending` (CT-API-AUDIT has no running). A ready export carries
 *   a download URL that only GETs its file, for AUDIT_EXPORT_URL_TTL_S (at most 900 s, and never
 *   past the file's own expiry); once the file's 24 h are up it shows `expired`. A failed export
 *   says why in `failure_reason`, a safe code (`row_cap_exceeded`, `storage_unavailable`,
 *   `internal`); `row_count` is set once known. Both are additions to the contract's object.
 * - A database timeout or lost connection is a 503 with `retry_after_s`.
 *
 * Owns: the rules above. Must not: read another workspace's events, or show an event past the
 * plan's retention.
 */
import { isId, newId, type Api } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  notFound,
  unavailable,
  validationFailed,
  type AuditActor,
  type AuditEmitter,
  type Logger,
  type Metrics,
  type Page,
  type SigningKeys,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import type { EntitlementEnforcer } from '../entitlements/enforcement.js';
import { AUDIT_EXPORT_ACTION, type AuditApiAction } from './actions.js';
import { exportWriter } from './csv.js';
import { filterNames, listFilterHash, type AuditFilters, type ExportRequest } from './filters.js';
import type { ObjectStore } from './object-store.js';
import { presentEvent, type AuditEventBody } from './present.js';
import {
  AUDIT_SORT,
  type AuditRepository,
  type EventScope,
  type ExportRow,
  type StoredFilters,
} from './repository.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The details of refusals (GUIDELINES §3.4). */
export const AUDIT_API_DETAILS = Object.freeze({
  noAuditLog: "The workspace's plan does not include the audit log.",
  exportNotFound: 'There is no such export.',
  tooMany: 'The export would hold too many events; narrow the range.',
  unavailable: 'The audit log is busy. Try again shortly.',
} as const);

/** CT-API-AUDIT's `AuditExport`, with `row_count` and `failure_reason` added. */
export type AuditExportBody = Api.AuditExport & {
  row_count?: number;
  failure_reason?: string;
};

/** `retentionDays` over B080's cached entitlements: the plan's `audit_log_days`. */
export const retentionFromEntitlements =
  (entitlements: Pick<EntitlementEnforcer, 'get'>) =>
  async (workspaceId: string): Promise<number> =>
    (await entitlements.get(workspaceId)).limits.audit_log_days;

/** Queues an export job (the worker's `audit-export` queue, job id the export id). */
export interface AuditExportQueue {
  enqueue(exportId: string): Promise<void>;
}

/** What the service needs. */
export interface AuditApiServiceDeps {
  repository: AuditRepository;
  /** The workspace's `audit_log_days` (CT-ENTITLEMENTS), from B080's cached entitlements. */
  retentionDays(workspaceId: string): Promise<number>;
  /** Writes `audit.export` in the export's transaction (`AUDIT_API_ACTIONS`). */
  emitter: Pick<AuditEmitter<AuditApiAction>, 'emit'>;
  queue: AuditExportQueue;
  store: Pick<ObjectStore, 'presignGet'>;
  /** CURSOR_SIGNING_KEYS (B025). */
  cursorKeys: SigningKeys;
  /** AUDIT_EXPORT_MAX_ROWS. */
  maxRows: number;
  /** AUDIT_EXPORT_URL_TTL_S. */
  urlTtlS: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** One list request. */
export interface AuditListQuery {
  filters: AuditFilters;
  /** 1..200 (B025 `parsePageQuery` checks it). */
  limit: number;
  cursor?: string;
}

/** Who asked for an export. */
export interface ExportRequester {
  actor: AuditActor;
  /** The request's `req_` id. */
  requestId?: string;
}

/** A failure that is the database's fault (timeout, lost connection): a 503. */
function databaseFailure(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    throw unavailable(1, AUDIT_API_DETAILS.unavailable, {
      cause: new Error('database unavailable'),
    });
  }
  throw err;
}

const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    return databaseFailure(err);
  }
};

/** The filters an export keeps, with its horizon. */
function stored(filters: AuditFilters, since: Date): StoredFilters {
  return {
    ...(filters.actor === undefined ? {} : { actor: filters.actor }),
    ...(filters.action === undefined ? {} : { action: filters.action }),
    ...(filters.range?.from === undefined ? {} : { from: filters.range.from.toISOString() }),
    ...(filters.range?.to === undefined ? {} : { to: filters.range.to.toISOString() }),
    since: since.toISOString(),
  };
}

/** The object key of an export's file: one per export, so a retry replaces it. */
export function exportObjectKey(row: Pick<ExportRow, 'id' | 'workspaceId' | 'format' | 'gzip'>) {
  const extension = exportWriter(row.format).extension;
  return `audit-exports/${row.workspaceId}/${row.id}.${extension}${row.gzip ? '.gz' : ''}`;
}

/** The audit API. */
export class AuditApiService {
  readonly #clock: () => number;
  readonly #logger: Logger | undefined;
  readonly #metrics: Metrics;

  constructor(private readonly deps: AuditApiServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#logger = deps.logger;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** The retention horizon at `now`; 403 when the plan has no audit log. */
  async #horizon(workspaceId: string, now: Date): Promise<Date> {
    const days = await this.deps.retentionDays(workspaceId);
    if (!(days > 0)) {
      throw new AppError('entitlement_required', { detail: AUDIT_API_DETAILS.noAuditLog });
    }
    return new Date(now.getTime() - days * DAY_MS);
  }

  /** One page of the workspace's audit log, newest first. */
  async list(
    workspaceId: string,
    q: AuditListQuery,
    now: Date = new Date(this.#clock()),
  ): Promise<Page<AuditEventBody>> {
    const since = await this.#horizon(workspaceId, now);
    const page = await guarded(() =>
      this.deps.repository.list(
        { workspaceId, filters: q.filters, since },
        {
          limit: q.limit,
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          sort: AUDIT_SORT,
          filterHash: listFilterHash(workspaceId, q.filters),
          keys: this.deps.cursorKeys,
          now: now.getTime(),
        },
      ),
    );
    return { ...page, data: page.data.map(presentEvent) };
  }

  /** Starts an export of the workspace's audit log; 422 when it would pass the cap. */
  async createExport(
    workspaceId: string,
    request: ExportRequest,
    requester: ExportRequester,
    now: Date = new Date(this.#clock()),
  ): Promise<AuditExportBody> {
    const since = await this.#horizon(workspaceId, now);
    const scope: EventScope = { workspaceId, filters: request.filters, since, until: now };
    const count = await guarded(() => this.deps.repository.countUpTo(scope, this.deps.maxRows));
    if (count > this.deps.maxRows) {
      throw validationFailed(
        [
          {
            pointer: '/from',
            code: 'out_of_range',
            detail: `the range holds more than ${this.deps.maxRows} events`,
          },
        ],
        AUDIT_API_DETAILS.tooMany,
      );
    }
    const id = newId('exp');
    const row = {
      id,
      workspaceId,
      requestedBy: requester.actor.id,
      format: request.format,
      gzip: request.gzip,
      filters: stored(request.filters, since),
      createdAt: now,
    };
    await guarded(() =>
      this.deps.repository.createExport(row, (trx) =>
        this.deps.emitter.emit(trx, {
          workspaceId,
          actor: requester.actor,
          action: AUDIT_EXPORT_ACTION,
          target: { type: 'audit_export', id },
          outcome: 'success',
          ...(requester.requestId === undefined ? {} : { requestId: requester.requestId }),
          meta: {
            format: request.format,
            gzip: request.gzip,
            filters: filterNames(request.filters).join(','),
          },
        }),
      ),
    );
    this.#metrics.counter('audit_exports_requested_total', { format: request.format }).inc();
    try {
      await this.deps.queue.enqueue(id);
    } catch {
      // The export is stored: the worker's sweep queues pending exports it finds.
      this.#logger?.warn({ export_id: id }, 'audit_export.enqueue_failed');
      this.#metrics.counter('audit_export_enqueue_failures_total').inc();
    }
    return {
      id,
      status: 'pending',
      format: request.format,
      created_at: now.toISOString(),
      expires_at: null,
      download_url: null,
    };
  }

  /** The workspace's export `id`, with a download URL when it is ready; 404 when there is none. */
  async getExport(
    workspaceId: string,
    id: string,
    now: Date = new Date(this.#clock()),
  ): Promise<AuditExportBody> {
    if (!isId('exp', id)) throw notFound(AUDIT_API_DETAILS.exportNotFound);
    const row = await guarded(() => this.deps.repository.getExport(workspaceId, id));
    if (row === null) throw notFound(AUDIT_API_DETAILS.exportNotFound);
    return this.#present(row, now);
  }

  #present(row: ExportRow, now: Date): AuditExportBody {
    const base = {
      id: row.id,
      format: row.format,
      created_at: row.createdAt.toISOString(),
      ...(row.rowCount === null ? {} : { row_count: row.rowCount }),
    };
    if (row.status === 'pending' || row.status === 'running') {
      return { ...base, status: 'pending', expires_at: null, download_url: null };
    }
    if (row.status === 'failed') {
      return {
        ...base,
        status: 'failed',
        expires_at: null,
        download_url: null,
        failure_reason: row.error ?? 'internal',
      };
    }
    const left =
      row.expiresAt === null ? 0 : Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000);
    const expiresAt = row.expiresAt === null ? null : row.expiresAt.toISOString();
    if (row.status === 'expired' || row.objectKey === null || left < 1) {
      return { ...base, status: 'expired', expires_at: expiresAt, download_url: null };
    }
    const filename = `audit-${row.id}.${exportWriter(row.format).extension}${row.gzip ? '.gz' : ''}`;
    const url = this.deps.store.presignGet(row.objectKey, Math.min(this.deps.urlTtlS, left), now, {
      filename,
    });
    return { ...base, status: 'ready', expires_at: expiresAt, download_url: url };
  }
}
