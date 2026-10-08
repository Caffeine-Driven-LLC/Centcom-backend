/**
 * The in-app inbox (B065, CT-API-NOTIFY), scope `profile`, users only:
 *
 * - `GET /v1/notifications?unread=true|false&limit=1..200&cursor=`: CT-PAGE of CT-NOTIF-PAYLOAD,
 *   newest first, 50 by default, with the caller's unread count in `X-Unread-Count`.
 * - `POST /v1/notifications/{id}/read`: 200 with the notification, `read_at` set. Marking it
 *   again answers the same, `read_at` unchanged. Another user's, an unknown or a malformed id is
 *   404.
 * - `POST /v1/notifications/read-all`: 200 `{updated}`, how many it marked; again, `0`.
 *
 * Bad parameters are 422 (`limit` outside 1..200, `unread` not true or false); an expired,
 * tampered or other filter's cursor is 400 `cursor_invalid` (B025). An API key is 403: machine
 * principals have no inbox. Register after the request-context, error-handler and auth plugins.
 *
 * Owns: the HTTP side of the inbox. Must not: take the user from anything but the token.
 */
import { AppError, booleanFilter, defineFilters, parsePageQuery } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { INBOX_SORT, type InboxService } from '../../modules/notifications/inbox/service.js';

/** Options for `notificationRoutes`. */
export interface NotificationRouteOptions {
  inbox: Pick<InboxService, 'list' | 'markRead' | 'markAllRead'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const NOTIFICATION_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a user has an inbox; API keys cannot use these routes.',
} as const);

/** The response header holding the caller's unread count. */
export const UNREAD_COUNT_HEADER = 'x-unread-count';

const LIST_SPEC = { sorts: [INBOX_SORT], defaultSort: INBOX_SORT } as const;
const QUERY_FILTERS = defineFilters({ unread: booleanFilter() });
const AUTH = { auth: { scopes: ['profile'] } };

function userOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: NOTIFICATION_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw new AppError('forbidden', { detail: NOTIFICATION_ROUTE_DETAILS.usersOnly });
  }
  return principal.userId;
}

export const notificationRoutes: FastifyPluginAsync<NotificationRouteOptions> = async (
  app,
  opts,
) => {
  const clock = opts.clock ?? Date.now;
  const { inbox } = opts;

  app.get('/v1/notifications', { config: AUTH }, async (request, reply) => {
    const userId = userOf(request);
    const { unread } = QUERY_FILTERS.parse(request.query);
    const query = parsePageQuery(request.query, LIST_SPEC);
    const { page, unreadCount } = await inbox.list(
      userId,
      {
        unread: unread ?? false,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      new Date(clock()),
    );
    reply.header(UNREAD_COUNT_HEADER, String(unreadCount));
    reply.header('cache-control', 'private, no-store');
    return page;
  });

  app.post('/v1/notifications/read-all', { config: AUTH }, async (request, reply) => {
    const userId = userOf(request);
    const result = await inbox.markAllRead(userId, new Date(clock()));
    reply.header('cache-control', 'no-store');
    return result;
  });

  app.post('/v1/notifications/:id/read', { config: AUTH }, async (request, reply) => {
    const userId = userOf(request);
    const id = String((request.params as Record<string, unknown>)['id'] ?? '');
    const notification = await inbox.markRead(userId, id, new Date(clock()));
    reply.header('cache-control', 'no-store');
    return notification;
  });
};
