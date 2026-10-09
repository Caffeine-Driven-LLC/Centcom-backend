/**
 * `POST /v1/workspaces/{id}/coupons/redeem` (B079, CT-API-BILLING `redeemCoupon`), scope
 * `billing:write`, `Idempotency-Key` accepted:
 *
 * - The workspace's owner and billing members may redeem (B021 RBAC `billing.manage`, CT-RBAC
 *   "Change plan, payment method, seats"); admins, members and guests get 403; anyone else (and
 *   an unknown or malformed id) 404. An API key needs `billing:write` and its own workspace.
 * - The attempt is counted (10 per workspace, and per client address, per hour; then 429 with
 *   `Retry-After`) in this route's `preValidation`, after the caller is authorised and before
 *   B024 claims the Idempotency-Key: a 429 is never stored and replayed for a day, and refused
 *   callers burn no one's attempts. A replay is an attempt too.
 * - The body is `CouponRedeem` (`{code}`, 1 to 64 characters); a body that is not one is a 422
 *   `validation_failed`. Every code that cannot be redeemed is the same 422 `coupon_invalid` at
 *   `/code` (see `PromotionService.redeem`).
 * - 200 with the workspace's `Subscription` after the coupon; a replay with the same key and body
 *   answers the stored response with `Idempotency-Replayed: true` (B024), the same key with
 *   another body 409 `idempotency_conflict`.
 *
 * Register after the request-context, error-handler, auth, rate-limit, idempotency, RBAC and
 * audit plugins.
 *
 * Owns: the HTTP side. Must not: log or echo the code, or decide who may redeem.
 */
import { parseIdempotencyKey, type Actor } from '@centcom/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PromotionService } from '../modules/billing/promotions/service.js';
import { workspaceAccess } from '../modules/workspaces/access.js';
import { requireScope } from '../plugins/rbac.js';

/** Options for `couponRoutes`. */
export interface CouponRouteOptions {
  promotions: Pick<PromotionService, 'redeem' | 'countAttempt'>;
  /** The client address (B023's `resolveClientIp` with the trusted hops); default the socket's. */
  clientIp?(request: FastifyRequest): string;
}

const SCOPE = requireScope('billing:write');

export const couponRoutes: FastifyPluginAsync<CouponRouteOptions> = async (app, opts) => {
  const clientIp = opts.clientIp ?? ((request: FastifyRequest) => request.ip);
  const access = new WeakMap<FastifyRequest, { actor: Actor; workspaceId: string }>();

  app.post(
    '/v1/workspaces/:id/coupons/redeem',
    {
      // Before B024's preHandler: authorise, then count the attempt.
      preValidation: async (request, reply) => {
        await SCOPE.call(app, request, reply);
        const allowed = await workspaceAccess(request, 'billing.manage');
        access.set(request, allowed);
        await opts.promotions.countAttempt(allowed.workspaceId, clientIp(request));
      },
      config: { idempotency: 'accepted' },
    },
    async (request, reply) => {
      const allowed = access.get(request) ?? (await workspaceAccess(request, 'billing.manage'));
      const subscription = await opts.promotions.redeem({
        workspaceId: allowed.workspaceId,
        actor: allowed.actor,
        body: request.body,
        idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
        requestId: String(request.id),
        audit: (trx, input) => request.audit(trx, input),
      });
      reply.header('cache-control', 'no-store');
      return subscription;
    },
  );
};
