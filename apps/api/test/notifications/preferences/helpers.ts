/**
 * Fixtures for the preference tests (B066): an in-memory repository with the Postgres one's version
 * rules (insert at 1, +1 per write, compare-and-set on expected versions, 0 for "no row"), the
 * routes on the real auth plugin (B017) and optionally the rate-limit plugin (B023), and a valid
 * document builder.
 */
import { createMemoryRedis, defaultBuckets, type RateLimitPrincipal } from '@centcom/core';
import { fastify } from 'fastify';
import type { PreferencesRepository } from '../../../src/modules/notifications/preferences/repository.js';
import { PreferencesService } from '../../../src/modules/notifications/preferences/service.js';
import { authPlugin } from '../../../src/plugins/auth.js';
import { errorHandlerPlugin } from '../../../src/plugins/error-handler.js';
import { rateLimitPlugin } from '../../../src/plugins/rate-limit.js';
import { requestContextPlugin } from '../../../src/plugins/request-context.js';
import { notificationPreferenceRoutes } from '../../../src/routes/notification-preferences/index.js';
import { captureLogger } from '../../helpers.js';
import { memoryTokens, newId, T0, testClock } from '../../modules/auth/tokens/helpers.js';

export { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
export { newId, T0 };

/** The in-memory repository, and what it was asked. */
export function memoryPreferences(
  initial: Record<string, { doc: unknown; version: number }> = {},
  fail?: () => Error | undefined,
) {
  const rows = new Map(Object.entries(initial));
  const saves: { userId: string; doc: Record<string, unknown>; expected?: readonly number[] }[] =
    [];
  const repository: PreferencesRepository = {
    find: (userId) =>
      Promise.resolve().then(() => {
        const error = fail?.();
        if (error !== undefined) throw error;
        const row = rows.get(userId);
        return row === undefined ? null : { doc: structuredClone(row.doc), version: row.version };
      }),
    save: (userId, doc, _now, expected) =>
      Promise.resolve().then(() => {
        const error = fail?.();
        if (error !== undefined) throw error;
        saves.push({ userId, doc, ...(expected === undefined ? {} : { expected }) });
        const current = rows.get(userId)?.version ?? 0;
        if (expected !== undefined && !expected.includes(current)) return null;
        const stored = JSON.parse(JSON.stringify(doc)) as unknown;
        rows.set(userId, { doc: stored, version: current + 1 });
        return current + 1;
      }),
  };
  return { repository, rows, saves };
}

/** The routes over `repository`, optionally rate-limited to `rateLimit` requests a minute. */
export async function prefsApp(
  repository: PreferencesRepository = memoryPreferences().repository,
  opts: { rateLimit?: number } = {},
) {
  const clock = testClock();
  const { tokens } = memoryTokens({ clock });
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['profile'],
    }),
  );
  const captured = captureLogger();
  const preferences = new PreferencesService({
    repository,
    clock: clock.now,
    logger: captured.logger,
  });
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  if (opts.rateLimit !== undefined) {
    const redis = createMemoryRedis(clock.now);
    await app.register(rateLimitPlugin, {
      store: redis.rateLimit,
      clock: clock.now,
      config: {
        buckets: { ...defaultBuckets, user: { limit: opts.rateLimit, windowS: 60 } },
        trustedHops: 0,
        exempt: [],
      },
      principal: (request): RateLimitPrincipal | null => {
        const user = request.headers['x-test-user'];
        return typeof user === 'string' ? { kind: 'user', userId: user } : null;
      },
    });
  }
  await app.register(authPlugin, { tokens });
  await app.register(notificationPreferenceRoutes, { preferences });
  await app.ready();
  const bearerFor = async (userId: string, scopes = ['profile']) => {
    const { access_token: token } = await tokens.issueTokens({ userId, deviceId: null, scopes });
    return { authorization: `Bearer ${token}` };
  };
  return { app, clock, captured, preferences, bearerFor };
}

/** A valid PUT body: quiet hours 22:00 to 07:00 in Berlin, a few switches. */
export function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channels: {
      approval_needed: { inbox: true, push: true, email: false, os: true },
      mention: { push: true },
    },
    quiet_hours: {
      enabled: true,
      start: '22:00',
      end: '07:00',
      timezone: 'Europe/Berlin',
      allow_approval_needed: false,
    },
    ...overrides,
  };
}
