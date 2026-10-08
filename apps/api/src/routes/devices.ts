/**
 * `/v1/devices` (B020, CT-API-ACCOUNTS), users only:
 *
 * - `GET /v1/devices` (`profile`): the caller's devices, newest first, CT-PAGE (`limit` 50 by
 *   default, at most 200); a cursor works only for the user it was made for. `current` marks the
 *   device of the caller's token.
 * - `GET /v1/devices/{id}` (`profile`): one of the caller's devices.
 * - `DELETE /v1/devices/{id}` (`profile`): revokes it, 204, also when it already was.
 * - `GET /v1/devices/{id}/keys` (`sessions:read`): its public keys, for its owner or a user who
 *   shares a session with the owner.
 *
 * Another user's device, or one that does not exist, is 404 `not_found`, never 403. An API key is
 * 403: machine principals have no devices. Scopes are checked by the B017 auth plugin
 * (`config.auth`); `deviceHandlers` are shared with the CT-AUTH aliases (`auth-devices.ts`).
 *
 * Owns: the HTTP side of devices. Must not: answer anything but public keys, or cache a response
 * in shared caches.
 */
import { AppError, defineFilters, idFilter, parsePageQuery, type SigningKeys } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceService } from '../modules/devices/service.js';

/** Options for `deviceRoutes` and `authDeviceRoutes`. */
export interface DeviceRouteOptions {
  devices: DeviceService;
  /** CURSOR_SIGNING_KEYS (B025 `paginationConfig().signingKeys`). */
  cursorKeys: SigningKeys;
  /** Milliseconds, for cursors; default Date.now. */
  clock?: () => number;
}

/** The details of the routes' own refusals (GUIDELINES §3.4). */
export const DEVICE_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  usersOnly: 'Only a user has devices; API keys cannot use these routes.',
} as const);

const LIST_SPEC = { sorts: ['created'], defaultSort: 'created' } as const;
/** A cursor is bound to the user whose devices it pages: another user's cursor is a 400. */
const LIST_FILTERS = defineFilters({ user: idFilter('usr') });

/** The calling user and the device of their token; 401 without a caller, 403 for an API key. */
function callerOf(request: FastifyRequest): { userId: string; deviceId: string | null } {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: DEVICE_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null) {
    throw new AppError('forbidden', { detail: DEVICE_ROUTE_DETAILS.usersOnly });
  }
  return { userId: principal.userId, deviceId: principal.deviceId };
}

const idOf = (request: FastifyRequest): string =>
  String((request.params as Record<string, unknown>)['id'] ?? '');

/** Device data is the caller's own: never in shared caches. */
const privately = (reply: FastifyReply): FastifyReply =>
  reply.header('cache-control', 'private, no-store');

/** A route handler of these routes. */
type DeviceHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** The handlers the canonical routes and the CT-AUTH aliases share. */
export function deviceHandlers(
  opts: DeviceRouteOptions,
): Record<'list' | 'get' | 'revoke' | 'keys', DeviceHandler> {
  const clock = opts.clock ?? Date.now;
  const { devices } = opts;
  return {
    async list(request: FastifyRequest, reply: FastifyReply) {
      const caller = callerOf(request);
      const query = parsePageQuery(request.query, LIST_SPEC);
      const page = await devices.list(
        caller.userId,
        {
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          sort: query.sort,
          filterHash: LIST_FILTERS.hash({ user: caller.userId }),
          keys: opts.cursorKeys,
          now: clock(),
        },
        caller.deviceId,
      );
      privately(reply);
      return page;
    },
    async get(request: FastifyRequest, reply: FastifyReply) {
      const caller = callerOf(request);
      const device = await devices.get(caller.userId, idOf(request), caller.deviceId);
      privately(reply);
      return device;
    },
    async revoke(request: FastifyRequest, reply: FastifyReply) {
      const caller = callerOf(request);
      await devices.revokeDevice(caller.userId, idOf(request), { requestId: request.id });
      return reply.code(204).send();
    },
    async keys(request: FastifyRequest, reply: FastifyReply) {
      const caller = callerOf(request);
      const keys = await devices.keys(caller.userId, idOf(request));
      privately(reply);
      return keys;
    },
  };
}

const PROFILE = { auth: { scopes: ['profile'] } } as const;

export const deviceRoutes: FastifyPluginAsync<DeviceRouteOptions> = async (app, opts) => {
  const handlers = deviceHandlers(opts);
  app.get('/v1/devices', { config: PROFILE }, handlers.list);
  app.get('/v1/devices/:id', { config: PROFILE }, handlers.get);
  app.delete('/v1/devices/:id', { config: PROFILE }, handlers.revoke);
  app.get(
    '/v1/devices/:id/keys',
    { config: { auth: { scopes: ['sessions:read'] } } },
    handlers.keys,
  );
};
