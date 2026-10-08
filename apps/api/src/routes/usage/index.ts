/**
 * `POST /v1/usage/events` (B074, CT-API-USAGE), scope `usage:write`, devices of users only:
 *
 * - `Idempotency-Key` is required (B024): without it, 400 `idempotency_key_required`; a replay
 *   answers the stored response with `Idempotency-Replayed: true` and stores nothing new; with the
 *   idempotency store down, 503.
 * - The body is a `UsageBatch` of 1 to 500 events, at most 1 MiB (413 beyond). Any invalid event
 *   fails the whole batch with 422 and `errors[]` pointers (`/events/3/qty`); nothing is stored.
 * - 200 `{accepted, duplicates}`: events already stored for their workspace are duplicates.
 * - Each device may call it 60 times a minute (B023's `usage` bucket): the 61st is 429 with
 *   `Retry-After` and `RateLimit-*`.
 * - An API key (usage is device-reported) or a token without a device is 403, as is a
 *   `session_id` the caller does not take part in.
 *
 * Register after the request-context, error-handler, rate-limit, auth and idempotency plugins.
 *
 * Owns: the HTTP side. Must not: take the device or user from anything but the token.
 */
import { AppError } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { DevicePrincipal } from '../../modules/usage/attribution.js';
import type { UsageIngest } from '../../modules/usage/ingest.js';
import { MAX_BATCH_BYTES, parseUsageBatch } from '../../modules/usage/validate.js';

/** Options for `usageRoutes`. */
export interface UsageRouteOptions {
  ingest: Pick<UsageIngest, 'ingest'>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** The details of the route's own refusals (GUIDELINES §3.4). */
export const USAGE_ROUTE_DETAILS = Object.freeze({
  unauthenticated: 'Authentication is required.',
  devicesOnly:
    'Usage is reported by devices; API keys and tokens without a device cannot report it.',
} as const);

function deviceOf(request: FastifyRequest): DevicePrincipal {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError('unauthorized', { detail: USAGE_ROUTE_DETAILS.unauthenticated });
  }
  if (principal.kind !== 'user' || principal.userId === null || principal.deviceId === null) {
    throw new AppError('forbidden', { detail: USAGE_ROUTE_DETAILS.devicesOnly });
  }
  return {
    userId: principal.userId,
    deviceId: principal.deviceId,
    ...(principal.workspaceId === null ? {} : { workspaceId: principal.workspaceId }),
  };
}

export const usageRoutes: FastifyPluginAsync<UsageRouteOptions> = async (app, opts) => {
  const clock = opts.clock ?? Date.now;

  app.post(
    '/v1/usage/events',
    {
      bodyLimit: MAX_BATCH_BYTES,
      config: {
        auth: { scopes: ['usage:write'] },
        idempotency: 'required',
        rateLimit: { bucket: 'usage' },
      },
    },
    async (request) => {
      const device = deviceOf(request);
      const events = parseUsageBatch(request.body, new Date(clock()));
      return opts.ingest.ingest(device, events);
    },
  );
};
