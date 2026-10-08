/**
 * `GET /v1/workspaces/{id}/subscription` (B070, CT-API-BILLING), scope `billing:read`:
 *
 * - The workspace's owner, admins and billing members get 200 with its `Subscription`: plan,
 *   status, seats, interval, currency, period, `cancel_at_period_end`, `trial_end` and
 *   `grace_until`. Never a Stripe id, card detail or e-mail address.
 * - Members and guests get 403; anyone else (and an unknown or malformed id) 404, by B021's RBAC
 *   on roles read from the database (`billing.read`). An API key needs `billing:read` and its own
 *   workspace.
 * - A workspace with no subscription in effect is 404 `not_found` (it is on the free plan; its
 *   entitlements say so).
 * - It reads the database only, so it keeps answering while Stripe is down.
 *
 * Register after the request-context, error-handler, auth and RBAC plugins.
 *
 * Owns: the HTTP side. Must not: call Stripe, or decide entitlements.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { BillingService } from '../../modules/billing/subscriptions/service.js';
import { workspaceAccess } from '../../modules/workspaces/access.js';
import { requireScope } from '../../plugins/rbac.js';

/** Options for `subscriptionRoutes`. */
export interface SubscriptionRouteOptions {
  billing: Pick<BillingService, 'requireSubscription'>;
}

export const subscriptionRoutes: FastifyPluginAsync<SubscriptionRouteOptions> = async (
  app,
  { billing },
) => {
  app.get(
    '/v1/workspaces/:id/subscription',
    { preHandler: requireScope('billing:read') },
    async (request, reply) => {
      const { workspaceId } = await workspaceAccess(request, 'billing.read');
      const subscription = await billing.requireSubscription(workspaceId);
      reply.header('cache-control', 'private, no-cache');
      return subscription;
    },
  );
};
