/**
 * CT-AUTH's device aliases (B020): `GET /v1/auth/devices` and `DELETE /v1/auth/devices/{id}`
 * answer exactly as `GET /v1/devices` and `DELETE /v1/devices/{id}` (CT-API-ACCOUNTS), through the
 * same handlers and service. Scope `profile`; being under `/v1/auth/`, they count in the `auth`
 * rate-limit bucket (B023).
 *
 * Owns: the alias paths. Must not: differ from the canonical routes in any answer.
 */
import type { FastifyPluginAsync } from 'fastify';
import { deviceHandlers, type DeviceRouteOptions } from './devices.js';

const PROFILE = { auth: { scopes: ['profile'] } } as const;

export const authDeviceRoutes: FastifyPluginAsync<DeviceRouteOptions> = async (app, opts) => {
  const handlers = deviceHandlers(opts);
  app.get('/v1/auth/devices', { config: PROFILE }, handlers.list);
  app.delete('/v1/auth/devices/:id', { config: PROFILE }, handlers.revoke);
};
