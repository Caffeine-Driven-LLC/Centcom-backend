/**
 * The data export (B026): the document of a user's own records, and the runner the
 * `account-export` job calls.
 *
 * - **Document** (`buildExportDocument`, pure): one JSON object with the profile, preferences,
 *   devices with their public-key fingerprints (no keys), the user's own memberships (never the
 *   other members), API-key metadata (prefix, never the hash), notification preferences and the
 *   user's own audit events (ids, actions and outcomes; no meta), at most EXPORT_AUDIT_LIMIT of
 *   them, newest first (`audit_events_truncated` says when more exist). No session content: the
 *   backend has none in plaintext, and ciphertext is not the user's alone.
 * - **run**: claims the export (pending or running; anything else is `skipped`), builds the
 *   document, uploads it to `exports/<usr>/<exp>.json` and marks it ready for 7 days. A failure
 *   is thrown for the job to retry; on the last attempt the export is marked `failed` with a safe
 *   code (`storage_unavailable` when the upload failed, `internal` otherwise) and any file is
 *   deleted, so no partial blob stays behind.
 * - **sweep**: deletes the files of ready exports past their expiry and marks them `expired`, and
 *   returns the exports still pending after 5 minutes (their job may never have been queued).
 *
 * Owns: the document's shape and the export's states after creation. Must not: put another
 * user's data, a token, a key secret or a `ct` value in the document, or log its content.
 */
import { noopMetrics, type Logger, type Metrics } from '@centcom/core';
import { toApiUser } from '../me/service.js';
import { exportBlobKey, type ExportBlobStore } from './blob-store.js';
import type { AccountLifecycleStore, ExportData } from './store.js';

/** A ready export's file is kept this long. */
export const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many audit events go in one export. */
export const EXPORT_AUDIT_LIMIT = 10_000;
/** A pending export older than this is queued again by the sweep. */
export const EXPORT_STALE_MS = 5 * 60 * 1000;
/** Exports one sweep expires or requeues at most. */
export const EXPORT_SWEEP_BATCH = 100;
/** The document's format name and version. */
export const EXPORT_FORMAT = 'centcom.account-export';
export const EXPORT_FORMAT_VERSION = 1;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The export document of `data`, written at `now`. */
export function buildExportDocument(data: ExportData, now: Date, auditLimit = EXPORT_AUDIT_LIMIT) {
  const truncated = data.auditEvents.length > auditLimit;
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exported_at: now.toISOString(),
    profile: { ...toApiUser(data.user), status: data.user.status },
    devices: data.devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      fingerprint: d.fingerprint,
      created_at: d.created_at.toISOString(),
      last_seen_at: iso(d.last_seen_at),
      revoked_at: iso(d.revoked_at),
    })),
    memberships: data.memberships.map((m) => ({
      id: m.id,
      workspace_id: m.workspace_id,
      role: m.role,
      created_at: m.created_at.toISOString(),
    })),
    api_keys: data.apiKeys.map((k) => ({
      id: k.id,
      workspace_id: k.workspace_id,
      name: k.name,
      mode: k.mode,
      prefix: k.prefix,
      scope: k.scope,
      created_at: k.created_at.toISOString(),
      last_used_at: iso(k.last_used_at),
      expires_at: iso(k.expires_at),
      revoked_at: iso(k.revoked_at),
    })),
    notification_preferences: data.notificationPreferences,
    audit_events: data.auditEvents.slice(0, auditLimit).map((e) => ({
      id: e.id,
      workspace_id: e.workspace_id,
      action: e.action,
      target_type: e.target_type,
      target_id: e.target_id,
      outcome: e.outcome,
      created_at: e.created_at.toISOString(),
    })),
    audit_events_truncated: truncated,
  };
}

/** The upload failed: the file store's fault. */
class UploadFailedError extends Error {
  override name = 'UploadFailedError';
}

/** What the runner needs. */
export interface AccountExportRunnerDeps {
  store: AccountLifecycleStore;
  blobs: Pick<ExportBlobStore, 'put' | 'delete'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Runs exports and sweeps them (the `account-export` job's processor calls these). */
export class AccountExportRunner {
  readonly #clock: () => number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: AccountExportRunnerDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Writes export `exportId`; throws for the job to retry, marking it failed on the last attempt. */
  async run(exportId: string, opts: { finalAttempt: boolean }): Promise<'ready' | 'skipped'> {
    const row = await this.deps.store.claimExport(exportId);
    if (row === null) return 'skipped';
    const key = exportBlobKey(row.userId, row.id);
    try {
      // One more than the limit tells the document whether it was cut.
      const data = await this.deps.store.exportData(row.userId, EXPORT_AUDIT_LIMIT + 1);
      if (data === null) {
        await this.deps.store.markFailed(exportId, 'account_gone');
        return 'skipped';
      }
      const now = new Date(this.#clock());
      const body = new TextEncoder().encode(JSON.stringify(buildExportDocument(data, now)));
      try {
        await this.deps.blobs.put(key, body, 'application/json');
      } catch {
        throw new UploadFailedError('export upload failed');
      }
      await this.deps.store.markReady(
        exportId,
        key,
        body.byteLength,
        new Date(now.getTime() + EXPORT_RETENTION_MS),
      );
      this.#metrics.counter('account_exports_written_total').inc();
      return 'ready';
    } catch (err) {
      if (opts.finalAttempt) {
        const code = err instanceof UploadFailedError ? 'storage_unavailable' : 'internal';
        await this.deps.store.markFailed(exportId, code);
        await this.deps.blobs.delete(key).catch(() => undefined);
        this.#metrics.counter('account_exports_failed_total', { code }).inc();
        this.deps.logger?.warn({ export_id: exportId, code }, 'account_export.failed');
      }
      throw err;
    }
  }

  /** Expires due files and returns the exports to queue again. */
  async sweep(now: Date): Promise<{ expired: number; stale: string[] }> {
    const due = await this.deps.store.dueForExpiry(now, EXPORT_SWEEP_BATCH);
    let expired = 0;
    for (const row of due) {
      if (row.blobKey !== null) await this.deps.blobs.delete(row.blobKey);
      await this.deps.store.markExpired(row.id);
      expired += 1;
    }
    if (expired > 0) this.#metrics.counter('account_exports_expired_total').inc(expired);
    const stale = await this.deps.store.stalePending(
      new Date(now.getTime() - EXPORT_STALE_MS),
      EXPORT_SWEEP_BATCH,
    );
    return { expired, stale };
  }
}
