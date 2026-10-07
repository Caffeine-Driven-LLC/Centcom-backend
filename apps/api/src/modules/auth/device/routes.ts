/**
 * `POST /v1/auth/device/code` (B016, CT-AUTH): starts an RFC 8628 device grant. Public (the
 * terminal has no credential yet), JSON only, counted in the rate limiter's `auth` bucket (B023,
 * per address). The answer carries the device_code, a secret, so it is never cached.
 *
 * The verification page (a login lane) uses `DeviceGrantService` directly; polls go to
 * `POST /v1/auth/token` (`grant-handler.ts`).
 *
 * Owns: the HTTP side of starting a grant. Must not: log the body or the response.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { DeviceGrantService } from './service.js';

/** The largest request body read: names and two keys fit well within it. */
export const DEVICE_CODE_BODY_LIMIT = 8 * 1024;

/** Options for `deviceRoutes`. */
export interface DeviceRouteOptions {
  devices: DeviceGrantService;
}

export const deviceRoutes: FastifyPluginAsync<DeviceRouteOptions> = async (app, { devices }) => {
  app.post(
    '/v1/auth/device/code',
    {
      bodyLimit: DEVICE_CODE_BODY_LIMIT,
      config: { auth: false, rateLimit: { bucket: 'auth' } },
    },
    async (request, reply) => {
      const response = await devices.start(request.body, {
        ...(request.headers['user-agent'] === undefined
          ? {}
          : { userAgent: request.headers['user-agent'] }),
      });
      void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
      return response;
    },
  );
};
