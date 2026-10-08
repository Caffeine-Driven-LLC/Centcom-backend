/**
 * `/v1/notification-preferences` (B066, CT-API-NOTIFY), scope `profile`, users only:
 *
 * - `GET`: 200 with the caller's complete document (the contract defaults when they never saved
 *   one) and its ETag.
 * - `PUT` (`If-Match` optional): replaces the whole document; 200 with what was stored (complete,
 *   `inbox` kept on for `security_alert` and `billing_issue`) and the new ETag. A bad document is
 *   422 with pointers, a body over 8 KiB is 413, and an If-Match naming no current version is 412
 *   `precondition_failed`.
 *
 * Both routes count against the caller's rate-limit bucket (B023, CT-PAGE). An API key is 403:
 * machine principals have no notification preferences. Register after the request-context,
 * error-handler and auth plugins.
 *
 * Owns: the HTTP side. Must not: take the user from anything but the token.
 */
import { AppError } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { computeEtag, parseIfMatch } from '../../modules/me/etag.js';
import {
  parsePreferences,
  PREFERENCES_MAX_BYTES,
} from '../../modules/notifications/preferences/schema.js';
import {
  PREFERENCES_DETAILS,
  type PreferencesService,
} from '../../modules/notifications/preferences/service.js';

/** Options for `notificationPreferenceRoutes`. */
export interface NotificationPreferenceRouteOptions {
  preferences: Pick<PreferencesService, 'read' | 'replace'>;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const PREFERENCE_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a user has notification preferences; API keys cannot use these routes.',
} as const);

const AUTH = { auth: { scopes: ['profile'] } };
const PATH = '/v1/notification-preferences';

function userOf(request: FastifyRequest): string {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: PREFERENCE_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw new AppError('forbidden', { detail: PREFERENCE_ROUTE_DETAILS.usersOnly });
  }
  return principal.userId;
}

/** Private to the user; revalidate with the ETag. */
const headers = (reply: FastifyReply, version: number): FastifyReply =>
  reply
    .header('etag', computeEtag({ version: String(version) }))
    .header('cache-control', 'private, no-cache');

export const notificationPreferenceRoutes: FastifyPluginAsync<
  NotificationPreferenceRouteOptions
> = async (app, { preferences }) => {
  app.get(PATH, { config: AUTH }, async (request, reply) => {
    const { prefs, version } = await preferences.read(userOf(request));
    headers(reply, version);
    return prefs;
  });

  app.put(PATH, { config: AUTH, bodyLimit: PREFERENCES_MAX_BYTES }, async (request, reply) => {
    const userId = userOf(request);
    const prefs = parsePreferences(request.body);
    const result = await preferences.replace(
      userId,
      prefs,
      parseIfMatch(request.headers['if-match']),
    );
    if (result === 'stale') {
      throw new AppError('precondition_failed', { detail: PREFERENCES_DETAILS.stale });
    }
    headers(reply, result.version);
    return result.prefs;
  });
};
