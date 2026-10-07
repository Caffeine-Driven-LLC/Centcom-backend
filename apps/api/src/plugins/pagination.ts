/**
 * Pagination plugin (B025, CT-PAGE): `reply.page(data, nextCursor)` sends a list's CT-PAGE body,
 * `{data, next_cursor, has_more}`. The paging itself (parameters, signed cursors, filters, keyset
 * queries) is `@centcom/core`'s: a list route reads its query with `parsePageQuery` and its
 * filters' `parse`, pages with `paginate` (or `paginateArray`), and answers with `reply.page`.
 *
 * Owns: the reply decorator. Must not: add totals, offsets or page numbers to a list response.
 */
import { page } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyReply {
    /** Sends `{data, next_cursor, has_more}` (CT-PAGE); `has_more` is whether `nextCursor` is set. */
    page<T>(data: readonly T[], nextCursor: string | null): FastifyReply;
  }
}

/** `reply.page`: sends the CT-PAGE body of a list; a TypeError for anything else. */
function sendPage<T>(
  this: FastifyReply,
  data: readonly T[],
  nextCursor: string | null,
): FastifyReply {
  if (!Array.isArray(data) || (nextCursor !== null && typeof nextCursor !== 'string')) {
    throw new TypeError('reply.page: data must be an array and nextCursor a string or null');
  }
  return this.send(page(data, nextCursor));
}

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateReply('page', sendPage);
};

/** Adds `reply.page` to the whole instance. Register it before the list routes. */
export const paginationPlugin: FastifyPluginAsync = Object.assign(plugin, {
  [Symbol.for('skip-override')]: true,
  [Symbol.for('fastify.display-name')]: 'centcom-pagination',
});
