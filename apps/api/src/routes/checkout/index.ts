/**
 * `POST /v1/workspaces/{id}/checkout` (B071, CT-API-BILLING `createCheckout`), scope
 * `billing:write`, roles owner and billing, `Idempotency-Key` required:
 *
 * - 201 `{url, expires_at}` (`UrlResponse`): a Stripe-hosted checkout of the plan, interval,
 *   currency (default USD) and seats in the body, priced from the server's catalogue.
 * - The body's `success_url`, `cancel_url` and `return_url` are ignored: Stripe returns the
 *   customer to the configured billing page only.
 * - 422 with `errors[].pointer` for a plan, interval, currency or seat count not sold
 *   (`free`, `week`, `GBP`, team seats under 5 or over BILLING_MAX_SEATS, pro seats other than
 *   1); 409 when the workspace already has a subscription in effect; 403 for admins, members,
 *   guests and tokens without `billing:write`; 404 for anyone else.
 * - Idempotency (B024): the same key and body replay the stored 201 (`Idempotency-Replayed:
 *   true`, no second Stripe session); the same key with another body is 409
 *   `idempotency_conflict`; no key is 400 `idempotency_key_required`. The stored response holds
 *   the session URL, so it is kept encrypted (`sensitiveResponse`).
 * - One audit event `billing.checkout` (actor, workspace, plan, interval, seats); never the URL
 *   or a Stripe id.
 * - Every answer is `Cache-Control: no-store`, replays included (`noStore`).
 *
 * Register after the request-context, error-handler, idempotency, RBAC and audit plugins.
 *
 * Owns: the HTTP side. Must not: log the session URL, or read a URL or price from the request.
 */
import { validate } from '@centcom/contracts';
import { parseIdempotencyKey, validationFailed, type FieldError } from '@centcom/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CheckoutRequestInput,
  CheckoutService,
} from '../../modules/billing/checkout/service.js';
import {
  CURRENCIES,
  INCLUDED_SEATS,
  INTERVALS,
  PAID_PLANS,
} from '../../modules/billing/stripe/price-catalog.js';
import { workspaceAccess } from '../../modules/workspaces/access.js';
import { requireScope } from '../../plugins/rbac.js';

/** Options for `checkoutRoutes`. */
export interface CheckoutRouteOptions {
  checkout: Pick<CheckoutService, 'createCheckout' | 'maxSeats'>;
}

/** Body fields the route never reads: Stripe returns to the configured URLs only. */
export const IGNORED_FIELDS: readonly string[] = Object.freeze([
  'success_url',
  'cancel_url',
  'return_url',
]);

/** The 422 detail. */
export const CHECKOUT_BODY_DETAIL = 'Some fields of the checkout are not valid.';

/**
 * A route `onSend` hook marking every answer `Cache-Control: no-store`. A session URL grants the
 * session, and B024 replays only the content headers it stored, so the handler cannot set it
 * alone: route hooks also run on a replay.
 */
export async function noStore(
  _request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  void reply.header('cache-control', 'no-store');
  return payload;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One field's problem, or none. */
function oneOf(
  value: unknown,
  allowed: readonly string[],
  pointer: string,
  required: boolean,
): FieldError | null {
  if (value === undefined) {
    return required ? { pointer, code: 'required', detail: 'is required' } : null;
  }
  return typeof value === 'string' && allowed.includes(value)
    ? null
    : { pointer, code: 'invalid_value', detail: `must be one of ${allowed.join(', ')}` };
}

/**
 * A `CheckoutRequest` body: plan (`pro` or `team`), interval (`month` or `year`), currency (`USD`
 * or `EUR`, default USD) and seats (team 5 to `maxSeats`, default 5; pro exactly 1, default),
 * checked field by field and then against the contract's schema (the redirect fields left out:
 * they are never read). A 422 lists every problem with its JSON pointer.
 */
export function parseCheckoutRequest(body: unknown, maxSeats: number): CheckoutRequestInput {
  if (!isRecord(body)) {
    throw validationFailed([{ pointer: '', code: 'invalid_type', detail: 'must be an object' }]);
  }
  const fields = Object.fromEntries(
    Object.entries(body).filter(([key]) => !IGNORED_FIELDS.includes(key)),
  );
  const { plan, interval, currency, seats } = fields;
  const issues: FieldError[] = [
    oneOf(plan, PAID_PLANS, '/plan', true),
    oneOf(interval, INTERVALS, '/interval', true),
    oneOf(currency, CURRENCIES, '/currency', false),
  ].filter((issue): issue is FieldError => issue !== null);
  if (seats !== undefined) {
    if (typeof seats !== 'number' || !Number.isSafeInteger(seats) || seats < 1) {
      issues.push({ pointer: '/seats', code: 'invalid_type', detail: 'must be a whole number' });
    } else if (plan === 'team' && (seats < INCLUDED_SEATS.team || seats > maxSeats)) {
      issues.push({
        pointer: '/seats',
        code: 'out_of_range',
        detail: `must be from ${INCLUDED_SEATS.team} to ${maxSeats} for team`,
      });
    } else if (plan === 'pro' && seats !== INCLUDED_SEATS.pro) {
      issues.push({ pointer: '/seats', code: 'out_of_range', detail: 'must be 1 for pro' });
    }
  }
  if (issues.length === 0) {
    const checked = validate('api/CheckoutRequest', fields);
    if (!checked.ok) issues.push(...checked.errors);
  }
  if (issues.length > 0) throw validationFailed(issues, CHECKOUT_BODY_DETAIL);
  return {
    plan: plan as CheckoutRequestInput['plan'],
    interval: interval as CheckoutRequestInput['interval'],
    currency: (currency as CheckoutRequestInput['currency'] | undefined) ?? 'USD',
    ...(typeof seats === 'number' ? { seats } : {}),
  };
}

export const checkoutRoutes: FastifyPluginAsync<CheckoutRouteOptions> = async (
  app,
  { checkout },
) => {
  app.post(
    '/v1/workspaces/:id/checkout',
    {
      preHandler: requireScope('billing:write'),
      onSend: noStore,
      config: { idempotency: 'required', sensitiveResponse: true },
    },
    async (request, reply) => {
      const { actor, workspaceId } = await workspaceAccess(request, 'billing.manage');
      const input = parseCheckoutRequest(request.body, checkout.maxSeats);
      // The idempotency middleware has already required and checked the key.
      const key = parseIdempotencyKey(request.headers['idempotency-key']) ?? '';
      const session = await checkout.createCheckout(workspaceId, actor, input, key);
      request.audit.detached({
        action: 'billing.checkout',
        target: { type: 'workspace', id: workspaceId },
        meta: {
          plan: input.plan,
          interval: input.interval,
          seats: input.seats ?? INCLUDED_SEATS[input.plan],
        },
      });
      reply.code(201);
      return {
        url: session.url,
        ...(session.expiresAt === null ? {} : { expires_at: session.expiresAt }),
      };
    },
  );
};
