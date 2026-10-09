/**
 * `PATCH /v1/workspaces/{id}/seats` (B073, CT-API-BILLING `changeSeats`), scope `billing:write`,
 * `Idempotency-Key` accepted:
 *
 * - The workspace's owner and billing members may change seats (B021 RBAC `billing.manage`,
 *   CT-RBAC "Change plan, payment method, seats"); admins, members and guests get 403; anyone else
 *   (and an unknown or malformed id) 404. An API key needs `billing:write` and its own workspace.
 * - The body is `SeatChange` (`{seats}`, a whole number from 1); over BILLING_MAX_SEATS or not a
 *   whole number is 422 `validation_failed` at `/seats`.
 * - `?preview=true` answers what the change would cost (`SeatChangeResult` with `preview: true`
 *   and the proration) and changes nothing; otherwise the change is made and answered with
 *   `preview: false`. `preview` other than `true` or `false` is 422 at `/preview`.
 * - A change writes one audit event `billing.seats` (`from_seats`, `to_seats`; CT-API-AUDIT's
 *   name); a replay with the same key and body answers the stored response with
 *   `Idempotency-Replayed: true` (B024), the same key with another body 409
 *   `idempotency_conflict`.
 *
 * Register after the request-context, error-handler, auth, rate-limit, idempotency, RBAC and audit
 * plugins.
 *
 * Owns: the HTTP side. Must not: decide who may change seats, or call Stripe itself.
 */
import { validate } from '@centcom/contracts';
import { parseIdempotencyKey, validationFailed } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import type { SeatService } from '../../modules/billing/seats/service.js';
import { workspaceAccess } from '../../modules/workspaces/access.js';
import { requireScope } from '../../plugins/rbac.js';

/** Options for `seatRoutes`. */
export interface SeatRouteOptions {
  seats: Pick<SeatService, 'change' | 'preview'>;
}

/** The detail of a request that is not a `SeatChange`. */
export const SEAT_BODY_DETAIL = 'The request body must be {"seats": <a whole number>}.';

/** `?preview`: true, false, or absent; a 422 for anything else. */
function previewOf(query: unknown): boolean {
  const raw =
    typeof query === 'object' && query !== null
      ? (query as Record<string, unknown>)['preview']
      : undefined;
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw validationFailed(
    [{ pointer: '/preview', code: 'invalid_value', detail: 'must be true or false' }],
    SEAT_BODY_DETAIL,
  );
}

export const seatRoutes: FastifyPluginAsync<SeatRouteOptions> = async (app, { seats }) => {
  app.patch(
    '/v1/workspaces/:id/seats',
    {
      // Before B024's hook, so a replayed answer (which keeps content headers only) has it too.
      onRequest: (_request, reply, done) => {
        void reply.header('cache-control', 'no-store');
        done();
      },
      preHandler: requireScope('billing:write'),
      config: { idempotency: 'accepted' },
    },
    async (request) => {
      const { actor, workspaceId } = await workspaceAccess(request, 'billing.manage');
      const preview = previewOf(request.query);
      const checked = validate('api/SeatChange', request.body);
      if (!checked.ok) throw validationFailed(checked.errors, SEAT_BODY_DETAIL);
      if (preview) return seats.preview(workspaceId, checked.value.seats);
      return seats.change(workspaceId, actor, checked.value.seats, {
        idempotencyKey: parseIdempotencyKey(request.headers['idempotency-key']),
        requestId: String(request.id),
        audit: ({ fromSeats, toSeats }) =>
          request.audit.detached({
            action: 'billing.seats',
            target: { type: 'workspace', id: workspaceId },
            meta: { from_seats: fromSeats, to_seats: toSeats },
          }),
      });
    },
  );
};
