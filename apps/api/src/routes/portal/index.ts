/**
 * `POST /v1/workspaces/{id}/portal` (B071, CT-API-BILLING `createPortalSession`), scope
 * `billing:write`, roles owner and billing, `Idempotency-Key` accepted:
 *
 * - 200 `{url}` (`UrlResponse`): a Stripe billing portal session for the workspace's existing
 *   customer, returning to the configured billing page. The body's `return_url` is ignored.
 * - 404 when the workspace has no Stripe customer yet (the portal never creates one); 403 for
 *   admins, members, guests and tokens without `billing:write`; 404 for anyone else. A workspace
 *   whose payment is past due may use it (that is where it fixes the card).
 * - With an Idempotency-Key, the same key and body replay the stored 200 (kept encrypted: it
 *   holds the session URL).
 * - One audit event `billing.portal` (actor, workspace, plan); never the URL or a Stripe id.
 * - Every answer is `Cache-Control: no-store`, replays included (the checkout route's `noStore`).
 *
 * Register after the request-context, error-handler, idempotency, RBAC and audit plugins.
 *
 * Owns: the HTTP side. Must not: log the session URL, or read a URL from the request.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { CheckoutService } from '../../modules/billing/checkout/service.js';
import { workspaceAccess } from '../../modules/workspaces/access.js';
import { requireScope } from '../../plugins/rbac.js';
import { noStore } from '../checkout/index.js';

/** Options for `portalRoutes`. */
export interface PortalRouteOptions {
  checkout: Pick<CheckoutService, 'createPortal' | 'currentPlan'>;
}

export const portalRoutes: FastifyPluginAsync<PortalRouteOptions> = async (app, { checkout }) => {
  app.post(
    '/v1/workspaces/:id/portal',
    {
      preHandler: requireScope('billing:write'),
      onSend: noStore,
      config: { idempotency: 'accepted', sensitiveResponse: true },
    },
    async (request) => {
      const { actor, workspaceId } = await workspaceAccess(request, 'billing.manage');
      const session = await checkout.createPortal(workspaceId, actor);
      request.audit.detached({
        action: 'billing.portal',
        target: { type: 'workspace', id: workspaceId },
        meta: { plan: await checkout.currentPlan(workspaceId) },
      });
      return { url: session.url };
    },
  );
};
