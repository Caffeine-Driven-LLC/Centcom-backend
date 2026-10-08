/**
 * The Stripe gateway (B070): what billing asks of Stripe, as an interface, so the billing lanes
 * (B070 customers and subscriptions, B071 checkout and portal, B072 webhooks, B073 seats) run
 * against a fake in tests and `StripeClient` (stripe-client.ts) in production.
 *
 * Shapes are parsed down to what billing uses: no card data, no addresses, no full payloads.
 * Every write takes an idempotency key, derived by the caller from the workspace id and the
 * operation (`idempotencyKey`).
 *
 * Owns: the interface, the parsed shapes and their parser, and the errors. Must not: keep or log
 * a payload, an email or a key.
 */

/** One item of a Stripe subscription. */
export interface StripeSubItem {
  id: string;
  priceId: string;
  quantity: number;
  /** Unix seconds (API versions from 2025-03-31 put the period on items). */
  periodStart: number | null;
  periodEnd: number | null;
}

/** A Stripe subscription, as billing reads it. */
export interface StripeSub {
  /** Stripe's `sub_…`. */
  id: string;
  /** Stripe's `cus_…`. */
  customerId: string;
  /** Stripe's status, unmapped (`mapStripeStatus`). */
  status: string;
  cancelAtPeriodEnd: boolean;
  /** ISO 4217, upper case. */
  currency: string;
  items: StripeSubItem[];
  /** Unix seconds; from the subscription, or else from its first item. */
  periodStart: number | null;
  periodEnd: number | null;
  trialEnd: number | null;
  /** `metadata.workspace_id`, when set (B071's checkout sets it). */
  workspaceId: string | null;
}

/** A Stripe event, verified (`constructEvent`). */
export interface StripeEvent {
  id: string;
  type: string;
  /** Unix seconds. */
  created: number;
  /** `data.object`, unparsed: the webhook lane (B072) reads what it needs. */
  object: unknown;
}

/** An invoice preview (B073's proration preview), amounts in minor units. */
export interface StripeInvoicePreview {
  currency: string;
  amountDue: number;
  lines: { amount: number; proration: boolean }[];
  /** Unix seconds, or null. */
  nextPaymentAttempt: number | null;
}

/** A customer to create. */
export interface CreateCustomerInput {
  workspaceId: string;
  /** The billing contact's address; Stripe keeps it, Centcom does not. */
  email: string;
  name?: string;
  /** A BCP 47 tag for Stripe's e-mails and invoices. */
  locale?: string;
}

/** A hosted checkout of a subscription (B071). */
export interface CheckoutInput {
  customerId: string;
  workspaceId: string;
  priceId: string;
  /** Add-on seats (team), if any. */
  seats?: { priceId: string; quantity: number };
  successUrl: string;
  cancelUrl: string;
}

/** A hosted checkout session (B071): its URL, and when Stripe expires it (unix seconds). */
export interface CheckoutSession {
  url: string;
  expiresAt?: number;
}

/** A billing portal session (B071). */
export interface PortalInput {
  customerId: string;
  returnUrl: string;
}

/** Subscription items to set (B073): an existing item by id, or a new one by price. */
export interface SubscriptionItemsInput {
  subscriptionId: string;
  items: { id?: string; priceId: string; quantity: number; deleted?: boolean }[];
  prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice';
}

/** An invoice preview of changed items (B073). */
export interface PreviewInput {
  customerId: string;
  subscriptionId: string;
  items: SubscriptionItemsInput['items'];
}

/** What billing asks of Stripe. */
export interface StripeGateway {
  createCustomer(input: CreateCustomerInput, idempotencyKey: string): Promise<{ id: string }>;
  /** The customer whose `metadata.workspace_id` is `workspaceId`, if Stripe has one. */
  findCustomerByWorkspace(workspaceId: string): Promise<{ id: string } | null>;
  retrieveSubscription(id: string): Promise<StripeSub>;
  /** Sets `client_reference_id` and `metadata.workspace_id` to the workspace. */
  createCheckoutSession(input: CheckoutInput, idempotencyKey: string): Promise<CheckoutSession>;
  createPortalSession(input: PortalInput): Promise<{ url: string }>;
  updateSubscriptionItems(
    input: SubscriptionItemsInput,
    idempotencyKey: string,
  ): Promise<StripeSub>;
  previewInvoice(input: PreviewInput): Promise<StripeInvoicePreview>;
  /** Verifies a webhook's `Stripe-Signature` (300 s tolerance) and parses the event. */
  constructEvent(rawBody: string | Buffer, signature: string): StripeEvent;
}

/** Why a Stripe call failed. */
export type StripeErrorKind =
  /** Stripe could not be reached, timed out, or kept answering 429/5xx: try again later. */
  | 'unavailable'
  /** Stripe refused the request (4xx): retrying will not help. */
  | 'request'
  /** The secret key was refused (401/403). */
  | 'auth'
  /** Stripe answered something billing cannot read. */
  | 'invalid_response'
  /** A webhook signature did not verify, or is too old. */
  | 'signature'
  /** The gateway is not configured for this call (no key, no webhook secret). */
  | 'not_configured';

/** A failed Stripe call: its kind, HTTP status and Stripe error code; never the payload. */
export class StripeError extends Error {
  override name = 'StripeError';

  constructor(
    readonly kind: StripeErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly stripeCode: string | null = null,
  ) {
    super(message);
  }
}

/** The idempotency key of `operation` on `workspaceId`: the same for every retry of it. */
export const idempotencyKey = (workspaceId: string, operation: string): string =>
  `centcom-${workspaceId}-${operation}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const invalid = (what: string): StripeError =>
  new StripeError('invalid_response', `Stripe subscription: ${what}`);

/** Billing's view of a Stripe subscription object; a StripeError for anything else. */
export function parseStripeSubscription(raw: unknown): StripeSub {
  if (!isRecord(raw) || raw['object'] !== 'subscription') throw invalid('not a subscription');
  const id = raw['id'];
  const customer = isRecord(raw['customer']) ? raw['customer']['id'] : raw['customer'];
  const status = raw['status'];
  const currency = raw['currency'];
  if (typeof id !== 'string' || !id.startsWith('sub_')) throw invalid('id');
  if (typeof customer !== 'string' || !customer.startsWith('cus_')) throw invalid('customer');
  if (typeof status !== 'string') throw invalid('status');
  if (typeof currency !== 'string' || !/^[a-zA-Z]{3}$/.test(currency)) throw invalid('currency');
  const list = isRecord(raw['items']) ? raw['items']['data'] : undefined;
  if (!Array.isArray(list)) throw invalid('items');
  const items = list.map((item: unknown): StripeSubItem => {
    if (!isRecord(item) || typeof item['id'] !== 'string') throw invalid('item');
    const price = item['price'];
    const priceId = isRecord(price) ? price['id'] : price;
    if (typeof priceId !== 'string') throw invalid('item price');
    const quantity = item['quantity'] ?? 1;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw invalid('item quantity');
    }
    return {
      id: item['id'],
      priceId,
      quantity,
      periodStart: seconds(item['current_period_start']),
      periodEnd: seconds(item['current_period_end']),
    };
  });
  const metadata = isRecord(raw['metadata']) ? raw['metadata'] : {};
  const workspaceId = metadata['workspace_id'];
  return {
    id,
    customerId: customer,
    status,
    cancelAtPeriodEnd: raw['cancel_at_period_end'] === true,
    currency: currency.toUpperCase(),
    items,
    periodStart: seconds(raw['current_period_start']) ?? items[0]?.periodStart ?? null,
    periodEnd: seconds(raw['current_period_end']) ?? items[0]?.periodEnd ?? null,
    trialEnd: seconds(raw['trial_end']),
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
  };
}
