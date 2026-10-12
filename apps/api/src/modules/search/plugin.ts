/**
 * `GET /search` (B089): staff metadata search, meant for the internal admin listener. The
 * composition root mounts it there with B087's `requireStaff` as `requireAccess`; nothing mounts it
 * on the public API (the contracts define no search endpoint).
 *
 * Query: `q` (2 to 254 characters), `type` (`session`, `workspace`, `user`, `member`, comma-
 * separated or repeated; default all), `workspace` (a `wsp_` id), `limit` (1 to 50, default 20),
 * `cursor` (CT-PAGE). Answers `{data, next_cursor, has_more}` with `Cache-Control: no-store`.
 *
 * `searchForMember` is the member-facing variant for later lanes: the same search in `member` scope
 * (only the workspaces the user belongs to, no emails), with no route.
 *
 * Owns: the route. Must not: mount itself on the public listener, or log `q`.
 */
import { isId } from '@centcom/contracts';
import { validationFailed } from '@centcom/core';
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from 'fastify';
import { parseLimit, parseTypes } from './query.js';
import {
  assertSearchReady,
  searchMetadata,
  type SearchDeps,
  type SearchInput,
  type SearchPage,
} from './service.js';

/** Options of the plugin. */
export interface SearchPluginOptions {
  /** The access check (the admin listener's `requireStaff`). */
  requireAccess: preHandlerAsyncHookHandler;
  search: SearchDeps;
}

/** The query parameters `GET /search` takes (B087's `requireStaff` refuses any other). */
export const SEARCH_QUERY_PARAMS = Object.freeze(['q', 'type', 'workspace', 'limit', 'cursor']);

/**
 * Mounts `GET /search` in staff scope behind `requireAccess`; refuses to register (so the
 * listener does not start) without `pg_trgm`.
 */
export const searchPlugin: FastifyPluginAsync<SearchPluginOptions> = async (app, opts) => {
  await assertSearchReady(opts.search.db);
  const options = {
    preHandler: opts.requireAccess,
    config: { adminQuery: [...SEARCH_QUERY_PARAMS] },
  };
  app.get('/search', options, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const workspace = query['workspace'];
    if (workspace !== undefined && !isId('wsp', workspace)) {
      throw validationFailed([
        { pointer: '/workspace', code: 'invalid', detail: 'must be a workspace id' },
      ]);
    }
    const cursor = query['cursor'];
    const page = await searchMetadata(opts.search, {
      q: query['q'] as string,
      types: parseTypes(query['type']),
      ...(workspace === undefined ? {} : { workspaceId: workspace as string }),
      scope: { kind: 'staff' },
      limit: parseLimit(query['limit']),
      ...(typeof cursor === 'string' ? { cursor } : {}),
    });
    void reply.header('cache-control', 'no-store');
    return page;
  });
};

/** The member-facing search: `member` scope for `userId` (their workspaces only, no emails). */
export function searchForMember(
  deps: SearchDeps,
  userId: string,
  input: Omit<SearchInput, 'scope'>,
): Promise<SearchPage> {
  return searchMetadata(deps, { ...input, scope: { kind: 'member', userId } });
}
