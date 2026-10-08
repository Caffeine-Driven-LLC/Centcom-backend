/**
 * Entitlements plugin (B080, CT-ENTITLEMENTS, CT-ERR): puts the enforcer (`CachedEntitlements`) on
 * the instance as `app.entitlements`, and provides the route-level preHandlers hosted features use.
 *
 * - `requireEntitlement(key, opts?)` refuses when the workspace's plan does not allow `key`:
 *   - a flag off (`relay_access: false`) is 403 `entitlement_required`;
 *   - a count reached is 403 with the registry's code for it (`seat_limit_reached`,
 *     `member_limit_reached`, `webhook_limit_reached`, `api_key_limit_reached`, else
 *     `entitlement_required`). `opts.current(request)` says how many are in use; without it, a
 *     limit of 0 refuses and any other passes;
 *   - a null limit never refuses, and `lan_multiplayer` never does.
 * - `requireQuota(key, opts?)` refuses a metered action at its limit: 429 `quota_exceeded` with
 *   `retry_after_s` (and `Retry-After`) the seconds to the period's end.
 * - Both read the workspace from the route's `:id` unless `opts.workspace(request)` says otherwise,
 *   and fail closed (503) when the entitlements cannot be read.
 *
 * Register after the auth and RBAC plugins, and put these after the route's own access check, so
 * a caller who may not see the workspace never learns its plan.
 *
 * Owns: the decorator and the HTTP mapping of check results. Must not: trust a plan, role or `ent`
 * claim sent by the client.
 */
import { AppError, type ErrorCode } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { CheckResult, EntitlementEnforcer } from '../modules/entitlements/enforcement.js';
import type { LimitKey } from '../modules/entitlements/ports.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** B080's entitlements: cached reads and checks. */
    entitlements: EntitlementEnforcer;
  }
}

/** Options for `entitlementsPlugin`. */
export interface EntitlementsPluginOptions {
  enforcer: EntitlementEnforcer;
}

/** The details of refusals (GUIDELINES §3.4). */
export const ENTITLEMENT_REFUSALS = Object.freeze({
  flagOff: "The workspace's plan does not include this feature.",
  countReached: "The workspace has reached its plan's limit for this.",
  quotaReached: "The workspace has used its plan's quota for this period.",
} as const);

/** The registry's code for a count limit reached. */
export const COUNT_LIMIT_CODES: Readonly<Partial<Record<LimitKey, ErrorCode>>> = Object.freeze({
  max_seats: 'seat_limit_reached',
  max_session_members: 'member_limit_reached',
  webhooks_max: 'webhook_limit_reached',
  api_keys_max: 'api_key_limit_reached',
});

/** How a preHandler finds the workspace and the count in use. */
export interface RequireOptions {
  /** The workspace id; default the route's `:id`. */
  workspace?(request: FastifyRequest): string;
  /** How many of `key` are in use (counts only). */
  current?(request: FastifyRequest): number | Promise<number>;
}

/** The AppError of a refused check. */
export function refusal(key: LimitKey, result: Exclude<CheckResult, { allowed: true }>): AppError {
  if (result.reason === 'quota_reached') {
    return new AppError('quota_exceeded', {
      detail: ENTITLEMENT_REFUSALS.quotaReached,
      ...(result.retry_after_s === undefined ? {} : { retryAfterS: result.retry_after_s }),
    });
  }
  if (result.reason === 'count_reached') {
    return new AppError(COUNT_LIMIT_CODES[key] ?? 'entitlement_required', {
      detail: ENTITLEMENT_REFUSALS.countReached,
    });
  }
  return new AppError('entitlement_required', { detail: ENTITLEMENT_REFUSALS.flagOff });
}

function workspaceOf(request: FastifyRequest, opts: RequireOptions): string {
  if (opts.workspace !== undefined) return opts.workspace(request);
  const id = (request.params as Record<string, unknown> | undefined)?.['id'];
  if (typeof id !== 'string') throw new TypeError('requireEntitlement: the route has no :id');
  return id;
}

/** A preHandler refusing requests the workspace's plan does not allow (`key`). */
export function requireEntitlement(
  key: LimitKey,
  opts: RequireOptions = {},
): preHandlerAsyncHookHandler {
  return async function (request) {
    if (key === 'lan_multiplayer') return;
    const workspaceId = workspaceOf(request, opts);
    const current = opts.current === undefined ? undefined : await opts.current(request);
    const result = await request.server.entitlements.check(workspaceId, key, current);
    if (!result.allowed) throw refusal(key, result);
  };
}

/** A preHandler refusing a metered action once the period's quota is used (`key`). */
export function requireQuota(
  key: 'hosted_minutes_month' | 'queue_items_month',
  opts: Pick<RequireOptions, 'workspace'> = {},
): preHandlerAsyncHookHandler {
  return requireEntitlement(key, opts);
}

const plugin: FastifyPluginAsync<EntitlementsPluginOptions> = async (app, { enforcer }) => {
  app.decorate('entitlements', enforcer);
};

/** Adds `app.entitlements` to the whole instance. */
export const entitlementsPlugin: FastifyPluginAsync<EntitlementsPluginOptions> = Object.assign(
  plugin,
  {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'centcom-entitlements',
  },
);
