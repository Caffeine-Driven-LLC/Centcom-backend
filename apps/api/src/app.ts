/**
 * `buildApp` (B102): the API as a Fastify instance, without a process or a port, so the entrypoint
 * and the tests build the very same thing.
 *
 * Plugin order is the one the lanes require: request context first (ids, access log), then the
 * error handler, the rate limiter (it counts before body parsing and any handler), the web token
 * cookies (they hook the token route as it registers) and the auth plugin, and only then the
 * route modules of `modules.ts`.
 *
 * Owns: the order and the module loop. Must not: listen, read the environment, or open
 * connections.
 */
import { AppError } from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import { createContext, type AppDeps } from './context.js';
import { API_MODULES, type ApiModule } from './modules.js';
import { webTokenCookiePlugin } from './modules/auth/web-session/cookies.js';
import { principalActor } from './modules/apikeys/authenticator.js';
import { auditPlugin } from './plugins/audit.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin, frameworkErrorHandler } from './plugins/error-handler.js';
import { idempotencyPlugin } from './plugins/idempotency.js';
import { rbacPlugin } from './plugins/rbac.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { requestContextPlugin } from './plugins/request-context.js';

export interface BuildOptions {
  /** Replaces the module list (tests). */
  modules?: readonly ApiModule[];
}

export async function buildApp(
  deps: AppDeps,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const ctx = createContext(deps);
  const { config, logger, metrics } = ctx;
  const app = fastify({
    logger: false,
    requestTimeout: config.base.requestTimeoutMs,
    frameworkErrors: frameworkErrorHandler({ logger }),
  });

  await app.register(requestContextPlugin, { logger, metrics });
  await app.register(errorHandlerPlugin, { logger });
  await app.register(rateLimitPlugin, {
    store: ctx.redis.rateLimit,
    config: config.rateLimit,
    kv: ctx.redis.kv,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    // No `principal`: the limiter counts everyone per address until the auth plugin can run
    // before it without letting bad credentials escape the count (a follow-up of this lane).
    logger,
    metrics,
  });
  await app.register(webTokenCookiePlugin, { allowedOrigins: config.pkce.allowedOrigins });
  await app.register(authPlugin, { tokens: ctx.tokens });
  await app.register(idempotencyPlugin, {
    kv: ctx.redis.kv,
    principal: (request) => request.principal?.userId ?? request.principal?.keyId ?? null,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    logger,
    metrics,
  });
  await app.register(rbacPlugin, {
    authorizer: ctx.rbac,
    actor: (request) => principalActor(request.principal),
  });
  await app.register(auditPlugin, { emitter: ctx.audit });

  for (const module of options.modules ?? API_MODULES) {
    const reason = module.skip?.(ctx) ?? null;
    if (reason !== null) {
      logger.info({ module: module.name, reason }, 'api.module_skipped');
      continue;
    }
    try {
      await app.register(async (scope) => module.register(scope, ctx));
    } catch (err) {
      throw new AppError('internal_error', {
        detail: `The ${module.name} module failed to register.`,
        cause: err,
      });
    }
  }
  return app;
}
