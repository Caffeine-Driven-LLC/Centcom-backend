/**
 * Who may read or purge a session's history (B055, CT-API-SESSIONS, CT-RBAC), and the Postgres
 * answer to "who is this caller in this session".
 *
 * - **Read** (`page`): any participant (host, editor or viewer: a live `session_members` row of a
 *   user still in the session's workspace). A share-link guest (B068) reads only while the session
 *   shares its history. Anyone else, or an unknown session: 404 `not_found` (the session is not
 *   revealed). A blob that cannot be read: 503 with `retry_after_s`, never a partial page.
 * - **Purge**: the host or the workspace's owner: 204 and one `history.purge` audit event (frame
 *   and blob counts only). Another participant: 403 `host_required`; anyone else: 404. A purge that
 *   fails partway answers 503: it is resumable, so retrying finishes it.
 * - The "share history" policy is the workspace's (`workspace_settings.share_history`, default
 *   on) until per-session policies (CT-WS-CONTROL `control.policy`, B051) are stored.
 *
 * Owns: these rules. Must not: show history to a non-participant, or log a frame.
 */
import {
  AppError,
  noopMetrics,
  notFound,
  unavailable,
  type AuditEvent,
  type Logger,
  type Metrics,
} from '@centcom/core';
import {
  isConnectionError,
  type HistoryDatabase,
  type WorkspaceSettingsDatabase,
} from '@centcom/db';
import type { Kysely } from 'kysely';
import type { HistoryAccess, HistoryRead, HistoryStore, SessionStanding } from './ports.js';

/** The details of refusals (GUIDELINES §3.4). */
export const HISTORY_DETAILS = Object.freeze({
  notFound: 'There is no such session.',
  notShared: 'This session does not share its history with guests.',
  hostOnly: 'Only the host or the workspace owner may purge the history.',
  unavailable: 'The session history cannot be read right now; try again shortly.',
  purgeIncomplete: 'The purge did not finish; send the request again to complete it.',
} as const);

/** Who asks. */
export interface HistoryCaller {
  userId: string;
  /** The request's `req_` id, for the audit event. */
  requestId?: string;
}

/** What the service needs. */
export interface HistoryServiceDeps {
  store: Pick<HistoryStore, 'read' | 'purge'>;
  access: HistoryAccess;
  /** Writes `history.purge` (B036, in the background: a purge spans the object store). */
  audit: { emitDetached(event: AuditEvent): void };
  logger?: Logger;
  metrics?: Metrics;
}

/** May `s` read the history? */
export const mayRead = (s: SessionStanding): boolean =>
  s.shareLinkGuest ? s.shareHistory : s.role !== null;

/** History reads and purges. */
export class HistoryService {
  readonly #metrics: Metrics;

  constructor(private readonly deps: HistoryServiceDeps) {
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  async #standing(sid: string, caller: HistoryCaller): Promise<SessionStanding> {
    let standing: SessionStanding | null;
    try {
      standing = await this.deps.access.standing(sid, caller);
    } catch (err) {
      throw dbFailure(err);
    }
    if (standing === null) throw notFound(HISTORY_DETAILS.notFound);
    return standing;
  }

  /** A page of the session's history after `afterSeq`. */
  async page(
    sid: string,
    caller: HistoryCaller,
    afterSeq: number,
    limit: number,
  ): Promise<HistoryRead> {
    const standing = await this.#standing(sid, caller);
    if (!mayRead(standing)) {
      if (standing.shareLinkGuest)
        throw new AppError('forbidden', { detail: HISTORY_DETAILS.notShared });
      throw notFound(HISTORY_DETAILS.notFound);
    }
    try {
      return await this.deps.store.read(sid, afterSeq, limit);
    } catch (err) {
      this.#metrics.counter('history_read_failures_total').inc();
      this.deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'history.read_failed',
      );
      throw unavailable(1, HISTORY_DETAILS.unavailable, {
        cause: new Error('history read failed'),
      });
    }
  }

  /** Purges the session's history (host or workspace owner). */
  async purge(sid: string, caller: HistoryCaller): Promise<void> {
    const standing = await this.#standing(sid, caller);
    if (standing.role !== 'host' && !standing.workspaceOwner) {
      if (standing.role === null || standing.shareLinkGuest)
        throw notFound(HISTORY_DETAILS.notFound);
      throw new AppError('host_required', { detail: HISTORY_DETAILS.hostOnly });
    }
    let result: { deleted: number; blobs: number };
    try {
      result = await this.deps.store.purge(sid);
    } catch (err) {
      this.#metrics.counter('history_purge_failures_total').inc();
      this.deps.logger?.warn(
        { sid, error: err instanceof Error ? err.name : 'unknown' },
        'history.purge_incomplete',
      );
      throw unavailable(5, HISTORY_DETAILS.purgeIncomplete, { cause: new Error('purge failed') });
    }
    this.#metrics.counter('history_purges_total').inc();
    this.deps.audit.emitDetached({
      workspaceId: standing.workspaceId,
      actor: { type: 'user', id: caller.userId },
      action: 'history.purge',
      target: { type: 'session', id: sid },
      outcome: 'success',
      ...(caller.requestId === undefined ? {} : { requestId: caller.requestId }),
      meta: { frames: result.deleted, blobs: result.blobs },
    });
  }
}

/** A database timeout or lost connection: a 503. */
function dbFailure(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (isConnectionError(err) || code === '57014') {
    return unavailable(1, HISTORY_DETAILS.unavailable, {
      cause: new Error('database unavailable'),
    });
  }
  return err;
}

/** The tables the access reads. */
export type AccessDatabase = HistoryDatabase & WorkspaceSettingsDatabase;

/** `HistoryAccess` over Postgres, for users (share-link guests arrive with B068). */
export function createPostgresHistoryAccess(db: Kysely<AccessDatabase>): HistoryAccess {
  return {
    async standing(sid, caller) {
      const session = await db
        .selectFrom('sessions as s')
        .leftJoin('workspaces as w', 'w.id', 's.workspace_id')
        .leftJoin('memberships as m', (join) =>
          join.onRef('m.workspace_id', '=', 's.workspace_id').on('m.user_id', '=', caller.userId),
        )
        .leftJoin('workspace_settings as ws', 'ws.workspace_id', 's.workspace_id')
        .select(['s.workspace_id', 'w.deleted_at', 'm.role as workspace_role', 'ws.share_history'])
        .where('s.id', '=', sid)
        .executeTakeFirst();
      if (session === undefined || session.deleted_at != null) return null;
      const inWorkspace = session.workspace_id === null || session.workspace_role !== null;
      const member = inWorkspace
        ? await db
            .selectFrom('session_members')
            .select('role')
            .where('session_id', '=', sid)
            .where('user_id', '=', caller.userId)
            .where('left_at', 'is', null)
            .orderBy('joined_at', 'desc')
            .limit(1)
            .executeTakeFirst()
        : undefined;
      return {
        workspaceId: session.workspace_id,
        role: member?.role ?? null,
        workspaceOwner: session.workspace_role === 'owner',
        shareLinkGuest: false,
        shareHistory: session.share_history ?? true,
      };
    },
  };
}
