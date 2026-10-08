/**
 * `GET /v1/plans` (B069, CT-API-BILLING): the public plans, cheapest first, each with its prices
 * (integer minor units in USD and EUR) and limits. No authentication; shared caches may keep it
 * for PLANS_MAX_AGE_S.
 *
 * Owns: the HTTP side of the catalog. Must not: show anything workspace-specific.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { EntitlementService } from '../../modules/entitlements/service.js';

/** Seconds a shared cache may keep the plans. */
export const PLANS_MAX_AGE_S = 300;

/** Options for `planRoutes`. */
export interface PlanRouteOptions {
  service: EntitlementService;
}

export const planRoutes: FastifyPluginAsync<PlanRouteOptions> = async (app, { service }) => {
  app.get('/v1/plans', { config: { auth: false } }, async (_request, reply) => {
    reply.header('cache-control', `public, max-age=${PLANS_MAX_AGE_S}`);
    return service.plans();
  });
};
