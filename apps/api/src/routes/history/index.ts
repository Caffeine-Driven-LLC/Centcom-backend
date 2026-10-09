/**
 * Session history routes (B055, CT-API-SESSIONS, CT-RESUME, CT-PAGE), users only:
 *
 * - `GET /v1/sessions/{id}/history?after_seq=&limit=&cursor=` (scope `sessions:read`,
 *   participants): `HistoryPage` `{data, next_cursor, has_more, head_seq?, earliest_seq?}`, the
 *   ciphertext frames in seq order (`HistoryFrame`, the envelope as stored), contiguous only. A
 *   `cursor` (signed, bound to the session, 24 h) continues after the previous page and takes
 *   the place of `after_seq`; `limit` is 1-200 (default 50).
 * - `DELETE /v1/sessions/{id}/history` (scope `sessions:host`, host or workspace owner): 204.
 *
 * No caller is 401 (the auth plugin's token errors come first). An API key, or a token without the
 * scope, is 403. Every answer is `Cache-Control: private, no-store`. Register after the
 * request-context, error-handler and auth plugins.
 *
 * Owns: the HTTP side. Must not: return a partial page, or log a frame.
 */
import { createHash } from 'node:crypto';
import { isId, type Api } from '@centcom/contracts';
import {
  AppError,
  decodeCursor,
  encodeCursor,
  hasScope,
  notFound,
  parsePageQuery,
  validationFailed,
  type SigningKeys,
} from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { StoredFrame } from '@centcom/storage';
import { HISTORY_DETAILS, type HistoryService } from '../../modules/history/service.js';

/** Options for `historyRoutes`. */
export interface HistoryRouteOptions {
  service: Pick<HistoryService, 'page' | 'purge'>;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const HISTORY_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a session participant can read its history; API keys cannot.',
  scope: 'The credential does not hold a scope this request needs.',
} as const);

/** The cursor's sort name. */
const SORT = 'seq';
const LIST_SPEC = { sorts: [SORT], defaultSort: SORT } as const;
const DIGITS = /^[0-9]{1,15}$/;

/** A cursor is bound to its session. */
const filterHash = (sid: string): string =>
  createHash('sha256').update(`history:${sid}`).digest('base64url').slice(0, 22);

/** The calling user; 401 without a caller, 403 for an API key or a missing `scope`. */
function userOf(request: FastifyRequest, scope: 'sessions:read' | 'sessions:host'): string {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: HISTORY_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw new AppError('forbidden', { detail: HISTORY_ROUTE_DETAILS.usersOnly });
  }
  if (!hasScope(principal, scope)) {
    throw new AppError('forbidden', { detail: HISTORY_ROUTE_DETAILS.scope });
  }
  return principal.userId;
}

/** The session id of the path; 404 for anything that is not one. */
function sessionOf(request: FastifyRequest): string {
  const sid = String((request.params as Record<string, unknown>)['id'] ?? '');
  if (!isId('ses', sid)) throw notFound(HISTORY_DETAILS.notFound);
  return sid;
}

/** `after_seq`: a whole number, 0 by default. */
function afterSeqOf(query: Record<string, unknown>): number {
  const raw = query['after_seq'];
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !DIGITS.test(raw)) {
    throw validationFailed([
      { pointer: '/after_seq', code: 'invalid_type', detail: 'must be a whole number' },
    ]);
  }
  return Number(raw);
}

/** A stored frame as CT-API-SESSIONS' `HistoryFrame`. */
export function historyFrame(sid: string, f: StoredFrame): Api.HistoryFrame {
  return {
    v: 1,
    t: f.kindClass,
    id: f.id,
    sid: sid as Api.HistoryFrame['sid'],
    from: f.from as Api.HistoryFrame['from'],
    ts: f.ts,
    seq: f.seq,
    ...(f.k === undefined ? {} : { k: f.k }),
    ...(f.p === null ? {} : { p: f.p }),
    ...(f.ct === null ? {} : { ct: f.ct as Api.HistoryFrame['ct'] }),
    ...(f.sig === undefined ? {} : { sig: f.sig }),
  };
}

const privately = (reply: FastifyReply): FastifyReply =>
  reply.header('cache-control', 'private, no-store');

export const historyRoutes: FastifyPluginAsync<HistoryRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;

  app.get(
    '/v1/sessions/:id/history',
    { config: { auth: { scopes: ['sessions:read'] } } },
    async (request, reply) => {
      const userId = userOf(request, 'sessions:read');
      const sid = sessionOf(request);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const page = parsePageQuery(query, LIST_SPEC);
      let afterSeq = afterSeqOf(query);
      if (page.cursor !== undefined) {
        const decoded = decodeCursor(page.cursor, opts.cursorKeys, clock(), {
          filterHash: filterHash(sid),
          sort: SORT,
        });
        const last = decoded.k[0];
        if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) {
          throw new AppError('cursor_invalid', { detail: 'The cursor is not valid.' });
        }
        afterSeq = last;
      }
      const read = await opts.service.page(
        sid,
        { userId, ...(isId('req', request.id) ? { requestId: request.id } : {}) },
        afterSeq,
        page.limit,
      );
      const next =
        read.nextAfterSeq === null
          ? null
          : encodeCursor(
              { k: [read.nextAfterSeq], f: filterHash(sid), s: SORT },
              opts.cursorKeys,
              clock(),
            );
      privately(reply);
      const body: Api.HistoryPage = {
        data: read.frames.map((f) => historyFrame(sid, f)),
        next_cursor: next,
        has_more: next !== null,
        ...(read.headSeq === null ? {} : { head_seq: read.headSeq }),
        ...(read.earliestSeq === null ? {} : { earliest_seq: read.earliestSeq }),
      };
      return body;
    },
  );

  app.delete(
    '/v1/sessions/:id/history',
    { config: { auth: { scopes: ['sessions:host'] } } },
    async (request, reply) => {
      const userId = userOf(request, 'sessions:host');
      const sid = sessionOf(request);
      await opts.service.purge(sid, {
        userId,
        ...(isId('req', request.id) ? { requestId: request.id } : {}),
      });
      privately(reply).code(204);
      return null;
    },
  );
};
