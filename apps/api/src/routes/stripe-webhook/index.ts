/**
 * `POST /internal/stripe/webhook` (B072): Stripe's webhook endpoint. Internal: not part of
 * CT-API-BILLING ("Stripe webhooks are not part of this contract") and kept out of public docs.
 *
 * - No user authentication (the signature is the credential), but the size limit (1 MiB, 413
 *   beyond) and the access log's redaction apply: the access log never records headers or bodies.
 * - The body is read as raw bytes (`raw-body.ts`) and handed with `Stripe-Signature` to
 *   `WebhookIngest.handle`, which verifies it before parsing.
 * - 200 `{received: true}` once the event is stored (or was already: a duplicate); 400
 *   `invalid_request` for a missing or bad signature, a stale timestamp, a tampered body or a body
 *   that is not a Stripe event (nothing stored); 500 when the event could not be stored (Stripe
 *   delivers it again) or no signing secret is configured.
 *
 * Owns: the HTTP side. Must not: log the signature header, the secret or the body.
 */
import { AppError } from '@centcom/core';
import type { FastifyPluginAsync } from 'fastify';
import { WebhookRejected, type WebhookIngest } from '../../modules/billing/webhooks/ingest.js';
import { RAW_BODY_LIMIT, rawBodyOf, useRawBody } from '../../plugins/raw-body.js';

/** The webhook's path. */
export const STRIPE_WEBHOOK_PATH = '/internal/stripe/webhook';

/** Options for `stripeWebhookRoutes`. */
export interface StripeWebhookRouteOptions {
  ingest: Pick<WebhookIngest, 'handle'>;
  /** Milliseconds, the receipt time; default Date.now. */
  clock?: () => number;
}

/** The details of the route's refusals (GUIDELINES §3.4). */
export const STRIPE_WEBHOOK_DETAILS = Object.freeze({
  rejected: 'The webhook is not a validly signed Stripe event.',
  notConfigured: 'The webhook endpoint is not configured.',
} as const);

export const stripeWebhookRoutes: FastifyPluginAsync<StripeWebhookRouteOptions> = async (
  app,
  opts,
) => {
  const clock = opts.clock ?? Date.now;
  useRawBody(app, { bodyLimit: RAW_BODY_LIMIT });

  app.post(
    STRIPE_WEBHOOK_PATH,
    { config: { auth: false }, bodyLimit: RAW_BODY_LIMIT },
    async (request, reply) => {
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string' || signature === '') {
        throw new AppError('invalid_request', { detail: STRIPE_WEBHOOK_DETAILS.rejected });
      }
      try {
        await opts.ingest.handle(rawBodyOf(request), signature, new Date(clock()));
      } catch (err) {
        if (err instanceof WebhookRejected) {
          if (err.reason === 'not_configured') {
            throw new AppError('internal_error', { detail: STRIPE_WEBHOOK_DETAILS.notConfigured });
          }
          throw new AppError('invalid_request', { detail: STRIPE_WEBHOOK_DETAILS.rejected });
        }
        throw err;
      }
      reply.header('cache-control', 'no-store');
      return { received: true };
    },
  );
};
