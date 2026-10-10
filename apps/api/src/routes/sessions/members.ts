/**
 * `GET /v1/sessions/{id}/members` (B054, CT-API-SESSIONS, CT-PAGE): the session's live members
 * in join order, each with its slot (B031), role (capped by the workspace role, as the relay caps
 * it), display name and the registered public keys of its device (`device_keys`: X25519,
 * Ed25519, fingerprint, revoked), never anything private or sealed.
 *
 * Only a live member of the session may list them; anyone else gets 404 `session_not_found`, so
 * a session's existence and its members' keys never reach a non-participant. `limit` 1-200
 * (default 50); the `cursor` is bound to the session and the caller, and pages by join order,
 * which never changes for a member (members who joined later only add pages at the end).
 *
 * Owns: the HTTP side of the members list. Must not: show a member of another session, or a key
 * that is not the device's registered public key.
 */
import { createHash } from 'node:crypto';
import type { Api } from '@centcom/contracts';
import { AppError, decodeCursor, encodeCursor, parsePageQuery } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf, liveRole, memberBody, notVisible, PRIVATE, sessionIdOf } from './access.js';
import type { SessionRouteDeps } from './index.js';

const SORT = 'join_order';
const LIST_SPEC = { sorts: [SORT], defaultSort: SORT } as const;

/** A cursor is bound to its session and caller. */
const filterHash = (sid: string, userId: string): string =>
  createHash('sha256').update(`members:${sid}:${userId}`).digest('base64url').slice(0, 22);

export const memberRoutes: FastifyPluginAsync<SessionRouteDeps> = async (app, deps) => {
  const clock = deps.clock ?? Date.now;

  app.get(
    '/v1/sessions/:id/members',
    { config: { auth: { scopes: ['sessions:read'] } } },
    async (request, reply) => {
      const caller = callerOf(request);
      const sid = sessionIdOf(request);
      const page = parsePageQuery(request.query ?? {}, LIST_SPEC);
      const standing = await deps.store.standing(sid, caller.userId);
      if (standing === null || liveRole(standing) === null) throw notVisible();
      const f = filterHash(sid, caller.userId);
      let after = 0;
      if (page.cursor !== undefined) {
        const decoded = decodeCursor(page.cursor, deps.cursorKeys, clock(), {
          filterHash: f,
          sort: SORT,
        });
        const last = decoded.k[0];
        if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) {
          throw new AppError('cursor_invalid', { detail: 'The cursor is not valid.' });
        }
        after = last;
      }
      const rows = await deps.store.members(sid, after, page.limit);
      const hasMore = rows.length > page.limit;
      const shown = rows.slice(0, page.limit);
      const last = shown.at(-1);
      const next =
        hasMore && last !== undefined
          ? encodeCursor({ k: [last.joinOrder], f, s: SORT }, deps.cursorKeys, clock())
          : null;
      const inWorkspace = standing.session.workspaceId !== null;
      reply.header('cache-control', PRIVATE);
      const body: Api.SessionMemberPage = {
        data: shown.map((m) => memberBody(m, inWorkspace)),
        next_cursor: next,
        has_more: next !== null,
      };
      return body;
    },
  );
};
