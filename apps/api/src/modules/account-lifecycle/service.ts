/**
 * Account deletion and data export (B026, CT-API-ACCOUNTS).
 *
 * - **Delete:** `requestDeletion` schedules the purge for now + 30 days and revokes every refresh
 *   token and device of the user in the same transaction (the store's rule); a repeated request
 *   keeps the first deadline. After the commit the token service flags the devices and the user in
 *   Redis, so an access token already handed out fails at once (`device_revoked`), and the
 *   `account-purge` job is scheduled for the deadline. The only owner of a workspace that still
 *   has other members gets 409 and nothing changes.
 * - **Restore:** `restore` (`POST /v1/me/restore`) ends a pending deletion before its deadline
 *   (409 when none is pending, 410 once the deadline has passed) and removes the delayed purge
 *   job; `cancelDeletion` does the same for sign-in flows, without the HTTP outcomes.
 * - **Export:** `requestExport` creates one export per 24 hours (429 with `Retry-After` for
 *   another; an `Idempotency-Key` replay is the plugin's), even while a deletion is pending (the
 *   right to data portability), and queues the `account-export` job. `getExport` shows `running`
 *   as `pending` (CT-API-ACCOUNTS has no `running`) and gives a ready export a download URL valid
 *   for 900 s (never past the file's own expiry); another user's export is a 404.
 * - A database timeout or lost connection is a 503 with `retry_after_s`. A failure after the
 *   commit (Redis, the queue) is logged and counted, never turned into an error: the sweeps catch
 *   up (the purge sweep queues due purges, the export sweep requeues stuck exports).
 *
 * Owns: the rules above. Must not: export another user's data, log a download URL, or let an
 * API key act on an account (the routes refuse machine principals).
 */
import { isId, newId, type Api } from '@centcom/contracts';
import {
  AppError,
  conflict,
  noopMetrics,
  notFound,
  tooManyRequests,
  unavailable,
  type AuditEmitter,
  type Logger,
  type Metrics,
} from '@centcom/core';
import { isConnectionError } from '@centcom/db';
import { toApiUser } from '../me/service.js';
import { ACCOUNT_ACTIONS, type AccountLifecycleAction } from './actions.js';
import type { ExportBlobStore } from './blob-store.js';
import type { AccountLifecycleStore, ExportRow } from './store.js';

/** CT-API-ACCOUNTS: the grace period before a deletion is carried out. */
export const DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** One export per this window. */
export const EXPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A download URL is valid this long. */
export const EXPORT_URL_TTL_S = 900;

/** The status of an export on the wire. */
export type ExportStatus = Api.DataExport['status'];
/** CT-API-ACCOUNTS' `DataExport`. */
export type ExportView = Api.DataExport;

/** The details of refusals (GUIDELINES §3.4). */
export const ACCOUNT_LIFECYCLE_DETAILS = Object.freeze({
  noAccount: 'There is no such account.',
  soleOwner:
    'You are the only owner of a workspace that has other members; transfer its ownership or remove the members first.',
  notPending: 'No account deletion is pending.',
  graceOver: 'The grace period is over; the account is being deleted.',
  exportLimit: 'A data export was already requested in the last 24 hours.',
  exportNotFound: 'There is no such export.',
  unavailable: 'The account service is busy. Try again shortly.',
} as const);

/** What a request lends the service. */
export interface RequestCtx {
  /** The request's `req_` id, for the audit event. */
  requestId?: string;
}

/** The token service's revocations (B017 `TokenService`). */
export interface TokenRevoker {
  revokeDevice(deviceId: string): Promise<void>;
  revokeUser(userId: string): Promise<number>;
}

/** The jobs the service starts (@centcom/worker `account-export` and `account-purge` queues). */
export interface AccountJobs {
  enqueueExport(exportId: string): Promise<void>;
  /** Schedules the purge of `userId` to run at `at`. */
  schedulePurge(userId: string, at: Date): Promise<void>;
  /** Removes the delayed purge of `userId`, if any. */
  cancelPurge(userId: string): Promise<void>;
}

/** What the service needs. */
export interface AccountLifecycleServiceDeps {
  store: AccountLifecycleStore;
  /** Writes `account.*` in the store's transactions (`ACCOUNT_LIFECYCLE_ACTIONS`). */
  emitter: Pick<AuditEmitter<AccountLifecycleAction>, 'emit'>;
  tokens: TokenRevoker;
  jobs: AccountJobs;
  blobs: Pick<ExportBlobStore, 'presignGet'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Makes `exp_` ids; default CT-IDS `newId`. */
  newId?: () => string;
  logger?: Logger;
  metrics?: Metrics;
}

/** A failure that is the database's fault (timeout, lost connection): a 503. */
function databaseFailure(err: unknown): never {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    throw unavailable(1, ACCOUNT_LIFECYCLE_DETAILS.unavailable, {
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

/** The account lifecycle. */
export class AccountLifecycleService {
  readonly #clock: () => number;
  readonly #newId: () => string;
  readonly #metrics: Metrics;
  readonly #logger: Logger | undefined;

  constructor(private readonly deps: AccountLifecycleServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#newId = deps.newId ?? (() => newId('exp'));
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#logger = deps.logger;
  }

  /** Runs a step that follows a commit; its failure is counted and logged, not thrown. */
  async #afterCommit(step: string, fn: () => Promise<unknown>, ids: Record<string, string>) {
    try {
      await fn();
    } catch (err) {
      this.#metrics.counter('account_lifecycle_after_commit_failures_total', { step }).inc();
      this.#logger?.error(
        { ...ids, step, error: (err as Error).name },
        'account.after_commit_failed',
      );
    }
  }

  /** Begins the deletion of `userId`'s account; 409 when it would orphan a workspace. */
  async requestDeletion(userId: string, ctx: RequestCtx): Promise<{ scheduledFor: string }> {
    const now = new Date(this.#clock());
    const outcome = await guarded(() =>
      this.deps.store.scheduleDeletion(
        userId,
        now,
        new Date(now.getTime() + DELETION_GRACE_MS),
        (trx, scheduledFor) =>
          this.deps.emitter.emit(trx, {
            workspaceId: null,
            actor: { type: 'user', id: userId },
            action: ACCOUNT_ACTIONS.deleteRequest,
            target: { type: 'user', id: userId },
            outcome: 'success',
            ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
            meta: { scheduled_for: scheduledFor.toISOString() },
          }),
      ),
    );
    if (outcome.kind === 'missing') throw notFound(ACCOUNT_LIFECYCLE_DETAILS.noAccount);
    if (outcome.kind === 'blocked') {
      this.#metrics.counter('account_deletions_blocked_total').inc();
      throw conflict(ACCOUNT_LIFECYCLE_DETAILS.soleOwner);
    }
    const ids = { user_id: userId };
    for (const deviceId of outcome.revokedDevices) {
      await this.#afterCommit('revoke_device', () => this.deps.tokens.revokeDevice(deviceId), ids);
    }
    await this.#afterCommit('revoke_user', () => this.deps.tokens.revokeUser(userId), ids);
    if (outcome.kind === 'scheduled') {
      this.#metrics.counter('account_deletions_requested_total').inc();
      this.#logger?.info(ids, 'account.deletion_scheduled');
      await this.#afterCommit(
        'schedule_purge',
        () => this.deps.jobs.schedulePurge(userId, outcome.scheduledFor),
        ids,
      );
    }
    return { scheduledFor: outcome.scheduledFor.toISOString() };
  }

  /** `POST /v1/me/restore`: the restored user; 409 with nothing pending, 410 after the deadline. */
  async restore(userId: string, ctx: RequestCtx): Promise<Api.User> {
    const now = new Date(this.#clock());
    const outcome = await guarded(() =>
      this.deps.store.restore(userId, now, (trx) =>
        this.deps.emitter.emit(trx, {
          workspaceId: null,
          actor: { type: 'user', id: userId },
          action: ACCOUNT_ACTIONS.restore,
          target: { type: 'user', id: userId },
          outcome: 'success',
          ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
        }),
      ),
    );
    if (outcome.kind === 'missing') throw notFound(ACCOUNT_LIFECYCLE_DETAILS.noAccount);
    if (outcome.kind === 'not_pending') throw conflict(ACCOUNT_LIFECYCLE_DETAILS.notPending);
    if (outcome.kind === 'expired') {
      throw new AppError('gone', { detail: ACCOUNT_LIFECYCLE_DETAILS.graceOver });
    }
    this.#metrics.counter('account_deletions_restored_total').inc();
    await this.#afterCommit('cancel_purge', () => this.deps.jobs.cancelPurge(userId), {
      user_id: userId,
    });
    return toApiUser(outcome.user);
  }

  /** Clears a pending deletion (for sign-in flows); the purge job, if it still fires, does nothing. */
  async cancelDeletion(userId: string): Promise<void> {
    const cancelled = await guarded(() => this.deps.store.cancelDeletion(userId));
    if (!cancelled) return;
    this.#metrics.counter('account_deletions_restored_total').inc();
    await this.#afterCommit('cancel_purge', () => this.deps.jobs.cancelPurge(userId), {
      user_id: userId,
    });
  }

  /** Starts an export of the user's own data; 429 within 24 hours of the last one. */
  async requestExport(
    userId: string,
    ctx: RequestCtx,
  ): Promise<{ id: string; status: ExportStatus; view: ExportView }> {
    const now = new Date(this.#clock());
    const id = this.#newId();
    const outcome = await guarded(() =>
      this.deps.store.createExport(
        { id, userId, createdAt: now },
        new Date(now.getTime() - EXPORT_WINDOW_MS),
        (trx) =>
          this.deps.emitter.emit(trx, {
            workspaceId: null,
            actor: { type: 'user', id: userId },
            action: ACCOUNT_ACTIONS.export,
            target: { type: 'export', id },
            outcome: 'success',
            ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
          }),
      ),
    );
    if (outcome.kind === 'missing') throw notFound(ACCOUNT_LIFECYCLE_DETAILS.noAccount);
    if (outcome.kind === 'limited') {
      const wait = outcome.latest.getTime() + EXPORT_WINDOW_MS - now.getTime();
      this.#metrics.counter('account_exports_limited_total').inc();
      throw tooManyRequests(
        Math.max(1, Math.ceil(wait / 1000)),
        ACCOUNT_LIFECYCLE_DETAILS.exportLimit,
      );
    }
    this.#metrics.counter('account_exports_requested_total').inc();
    await this.#afterCommit('enqueue_export', () => this.deps.jobs.enqueueExport(id), {
      export_id: id,
    });
    return {
      id,
      status: 'pending',
      view: {
        id,
        status: 'pending',
        created_at: now.toISOString(),
        expires_at: null,
        download_url: null,
        size_bytes: null,
      },
    };
  }

  /** The user's export `exportId`, with a download URL when ready; 404 for anything else. */
  async getExport(userId: string, exportId: string): Promise<ExportView> {
    if (!isId('exp', exportId)) throw notFound(ACCOUNT_LIFECYCLE_DETAILS.exportNotFound);
    const row = await guarded(() => this.deps.store.getExport(userId, exportId));
    if (row === null) throw notFound(ACCOUNT_LIFECYCLE_DETAILS.exportNotFound);
    return this.#present(row, new Date(this.#clock()));
  }

  #present(row: ExportRow, now: Date): ExportView {
    const base = {
      id: row.id,
      created_at: row.createdAt.toISOString(),
      size_bytes: row.sizeBytes,
    };
    if (row.status === 'pending' || row.status === 'running') {
      return { ...base, status: 'pending', expires_at: null, download_url: null };
    }
    if (row.status === 'failed') {
      return { ...base, status: 'failed', expires_at: null, download_url: null };
    }
    const expiresAt = row.expiresAt === null ? null : row.expiresAt.toISOString();
    const left =
      row.expiresAt === null ? 0 : Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000);
    if (row.status === 'expired' || row.blobKey === null || left < 1) {
      return { ...base, status: 'expired', expires_at: expiresAt, download_url: null };
    }
    const url = this.deps.blobs.presignGet(row.blobKey, Math.min(EXPORT_URL_TTL_S, left), now, {
      filename: `centcom-export-${row.id}.json`,
    });
    return { ...base, status: 'ready', expires_at: expiresAt, download_url: url };
  }
}
