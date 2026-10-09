/**
 * `StripeClient` (B070): the `StripeGateway` over Stripe's REST API, with `fetch`.
 *
 * - **Version:** pinned with `Stripe-Version` (STRIPE_API_VERSION_DEFAULT unless
 *   STRIPE_API_VERSION says otherwise); upgrades are explicit.
 * - **Requests:** form-encoded as Stripe expects (`metadata[workspace_id]`, `items[0][price]`),
 *   with a 10 s timeout. Every write carries the caller's `Idempotency-Key`.
 * - **Retries:** network errors, timeouts, 409/429/5xx and `Stripe-Should-Retry: true` are tried
 *   again up to 3 times, with full-jitter backoff (base 500 ms, cap 5 s) and the same idempotency
 *   key. After that the call fails as `unavailable`, which the API answers with 503. Other 4xx
 *   fail at once (`request`, or `auth` for 401/403).
 * - **Webhooks:** `constructEvent` checks `Stripe-Signature` (HMAC-SHA256 of `t.body`, any `v1`,
 *   300 s tolerance) with STRIPE_WEBHOOK_SECRET: one secret, or two separated by a comma while
 *   the endpoint's secret is rolled (B072); a signature from either verifies.
 *
 * Configuration: STRIPE_SECRET_KEY (required in production), STRIPE_API_VERSION,
 * STRIPE_WEBHOOK_SECRET, STRIPE_API_BASE (stripe-mock in tests).
 *
 * Owns: talking to Stripe. Must not: log or keep a key, a payload or an e-mail address.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ConfigError,
  defineConfig,
  envUrl,
  NODE_ENVS,
  secretString,
  z,
  type Env,
  Secret,
} from '@centcom/core';
import {
  parseStripeSubscription,
  StripeError,
  type CheckoutInput,
  type CheckoutSession,
  type CreateCustomerInput,
  type PortalInput,
  type PreviewInput,
  type StripeEvent,
  type StripeGateway,
  type StripeInvoicePreview,
  type StripeSub,
  type SubscriptionItemsInput,
} from './gateway.js';

/** The Stripe API version billing is written against. */
export const STRIPE_API_VERSION_DEFAULT = '2025-03-31.basil';
/** Per request. */
export const STRIPE_TIMEOUT_MS = 10_000;
/** Retries after the first attempt. */
export const STRIPE_RETRIES = 3;
export const STRIPE_BACKOFF_BASE_MS = 500;
export const STRIPE_BACKOFF_CAP_MS = 5_000;
/** How old a webhook signature may be. */
export const WEBHOOK_TOLERANCE_S = 300;

const SECRET_KEY = /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,250}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{10,250}$/;

/** The environment keys of Stripe. */
export const stripeEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development').meta({
    description: 'development, test or production; production requires STRIPE_SECRET_KEY.',
  }),
  STRIPE_SECRET_KEY: secretString().optional().meta({
    description:
      'Stripe secret (or restricted) key, sk_live_… or sk_test_…. Required in production.',
  }),
  STRIPE_API_VERSION: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/,
      'must be a Stripe API version such as 2025-03-31.basil',
    )
    .default(STRIPE_API_VERSION_DEFAULT)
    .meta({ description: 'The pinned Stripe API version.' }),
  STRIPE_WEBHOOK_SECRET: secretString().optional().meta({
    description:
      'Signing secret of the Stripe webhook endpoint (whsec_…), for B072; two separated by a comma while rolling it.',
  }),
  STRIPE_API_BASE: envUrl({ protocols: ['https:', 'http:'], plain: true })
    .default('https://api.stripe.com')
    .meta({ description: 'Stripe API origin (stripe-mock in tests).' }),
});

/** What the client needs. */
export interface StripeConfig {
  secretKey: Secret<string>;
  apiVersion: string;
  webhookSecret: Secret<string> | null;
  /** Every accepted webhook secret: the current one, and the previous one while rolling. */
  webhookSecrets?: readonly Secret<string>[];
  apiBase: string;
}

/** Most webhook secrets accepted at once (the new and the old one while rolling). */
export const MAX_WEBHOOK_SECRETS = 2;

/**
 * Reads the Stripe keys; null when no secret key is set outside production (billing off). A
 * ConfigError naming the key (never its value) for a malformed key, or none in production.
 */
export function loadStripeConfig(env?: Env): StripeConfig | null {
  const v = defineConfig(stripeEnvSchema, env);
  const issues: { key: string; problem: string }[] = [];
  if (v.STRIPE_SECRET_KEY === undefined) {
    if (v.NODE_ENV === 'production') {
      issues.push({ key: 'STRIPE_SECRET_KEY', problem: 'is required in production' });
    }
  } else if (!SECRET_KEY.test(v.STRIPE_SECRET_KEY.reveal())) {
    issues.push({
      key: 'STRIPE_SECRET_KEY',
      problem: 'must be a Stripe secret key (sk_… or rk_…)',
    });
  }
  const webhookParts =
    v.STRIPE_WEBHOOK_SECRET === undefined
      ? []
      : v.STRIPE_WEBHOOK_SECRET.reveal()
          .split(',')
          .map((part) => part.trim());
  if (
    webhookParts.length > MAX_WEBHOOK_SECRETS ||
    webhookParts.some((part) => !WEBHOOK_SECRET.test(part))
  ) {
    issues.push({
      key: 'STRIPE_WEBHOOK_SECRET',
      problem: 'must be one or two webhook signing secrets (whsec_…), separated by a comma',
    });
  }
  if (issues.length > 0) throw new ConfigError(issues);
  if (v.STRIPE_SECRET_KEY === undefined) return null;
  return {
    secretKey: v.STRIPE_SECRET_KEY,
    apiVersion: v.STRIPE_API_VERSION,
    webhookSecret: webhookParts[0] === undefined ? null : new Secret(webhookParts[0]),
    webhookSecrets: webhookParts.map((part) => new Secret(part)),
    apiBase: v.STRIPE_API_BASE.replace(/\/+$/, ''),
  };
}

/** A form value as Stripe reads it. */
export type FormValue =
  | string
  | number
  | boolean
  | undefined
  | readonly FormValue[]
  | { readonly [key: string]: FormValue };

/** `params` as `application/x-www-form-urlencoded`, nested the way Stripe expects. */
export function formEncode(params: Record<string, FormValue>): string {
  const pairs: string[] = [];
  const walk = (key: string, value: FormValue): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item: FormValue, i) => walk(`${key}[${i}]`, item));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return pairs.join('&');
}

/** What the client needs besides its configuration. */
export interface StripeClientOptions {
  config: StripeConfig;
  fetch?: typeof fetch;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** [0, 1); default Math.random. */
  random?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const RETRY_STATUSES = new Set([409, 429]);

/** The `StripeGateway` over Stripe's REST API. */
export class StripeClient implements StripeGateway {
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(private readonly options: StripeClientOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
  }

  /** Full-jitter backoff before retry `attempt` (0-based). */
  backoff(attempt: number): number {
    const ceiling = Math.min(STRIPE_BACKOFF_CAP_MS, STRIPE_BACKOFF_BASE_MS * 2 ** attempt);
    return Math.floor(this.#random() * ceiling);
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, FormValue> = {},
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const { config } = this.options;
    const body = formEncode(params);
    const url =
      method === 'GET' && body !== ''
        ? `${config.apiBase}${path}?${body}`
        : `${config.apiBase}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.secretKey.reveal()}`,
      'stripe-version': config.apiVersion,
      accept: 'application/json',
    };
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    }
    let last = 'no attempt';
    for (let attempt = 0; attempt <= STRIPE_RETRIES; attempt += 1) {
      if (attempt > 0) await this.#sleep(this.backoff(attempt - 1));
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          ...(method === 'POST' ? { body } : {}),
          signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
        });
      } catch (err) {
        last = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network error';
        continue;
      }
      const text = await response.text().catch(() => '');
      let json: unknown;
      try {
        json = text === '' ? {} : JSON.parse(text);
      } catch {
        json = undefined;
      }
      if (response.ok) {
        if (!isRecord(json))
          throw new StripeError('invalid_response', 'Stripe answered no JSON object');
        return json;
      }
      const error = isRecord(json) && isRecord(json['error']) ? json['error'] : {};
      const code = typeof error['code'] === 'string' ? error['code'] : null;
      const should = response.headers.get('stripe-should-retry');
      const retry =
        should === 'true' ||
        (should !== 'false' && (response.status >= 500 || RETRY_STATUSES.has(response.status)));
      if (retry) {
        last = `status ${response.status}`;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new StripeError('auth', 'Stripe refused the key', response.status, code);
      }
      throw new StripeError(
        'request',
        `Stripe refused the request (${response.status})`,
        response.status,
        code,
      );
    }
    throw new StripeError(
      'unavailable',
      `Stripe unavailable after ${STRIPE_RETRIES + 1} attempts (${last})`,
    );
  }

  async createCustomer(
    input: CreateCustomerInput,
    idempotencyKey: string,
  ): Promise<{ id: string }> {
    const json = await this.#request(
      'POST',
      '/v1/customers',
      {
        email: input.email,
        name: input.name,
        preferred_locales: input.locale === undefined ? undefined : [input.locale],
        metadata: { workspace_id: input.workspaceId },
      },
      idempotencyKey,
    );
    return { id: idOf(json, 'cus_') };
  }

  async findCustomerByWorkspace(workspaceId: string): Promise<{ id: string } | null> {
    if (!/^wsp_[0-9A-HJKMNP-TV-Z]{26}$/.test(workspaceId)) return null;
    const json = await this.#request('GET', '/v1/customers/search', {
      query: `metadata['workspace_id']:'${workspaceId}'`,
      limit: 1,
    });
    const data = json['data'];
    const first: unknown = Array.isArray(data) ? data[0] : undefined;
    return first === undefined ? null : { id: idOf(first, 'cus_') };
  }

  async retrieveSubscription(id: string): Promise<StripeSub> {
    if (!/^sub_[A-Za-z0-9]{1,250}$/.test(id)) {
      throw new StripeError('request', 'not a Stripe subscription id');
    }
    return parseStripeSubscription(await this.#request('GET', `/v1/subscriptions/${id}`));
  }

  async createCheckoutSession(
    input: CheckoutInput,
    idempotencyKey: string,
  ): Promise<CheckoutSession> {
    const lineItems: FormValue[] = [{ price: input.priceId, quantity: 1 }];
    if (input.seats !== undefined && input.seats.quantity > 0) {
      lineItems.push({ price: input.seats.priceId, quantity: input.seats.quantity });
    }
    const json = await this.#request(
      'POST',
      '/v1/checkout/sessions',
      {
        mode: 'subscription',
        customer: input.customerId,
        client_reference_id: input.workspaceId,
        line_items: lineItems,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        automatic_tax: { enabled: true },
        customer_update: { address: 'auto', name: 'auto' },
        tax_id_collection: { enabled: true },
        subscription_data: { metadata: { workspace_id: input.workspaceId } },
        metadata: { workspace_id: input.workspaceId },
      },
      idempotencyKey,
    );
    const expiresAt = json['expires_at'];
    return {
      url: urlOf(json),
      ...(typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > 0
        ? { expiresAt }
        : {}),
    };
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    const json = await this.#request('POST', '/v1/billing_portal/sessions', {
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: urlOf(json) };
  }

  async updateSubscriptionItems(
    input: SubscriptionItemsInput,
    idempotencyKey: string,
  ): Promise<StripeSub> {
    const json = await this.#request(
      'POST',
      `/v1/subscriptions/${input.subscriptionId}`,
      {
        items: input.items.map((item) => ({
          id: item.id,
          price: item.id === undefined ? item.priceId : undefined,
          quantity: item.deleted === true ? undefined : item.quantity,
          deleted: item.deleted === true ? true : undefined,
        })),
        proration_behavior: input.prorationBehavior ?? 'create_prorations',
      },
      idempotencyKey,
    );
    return parseStripeSubscription(json);
  }

  async previewInvoice(input: PreviewInput): Promise<StripeInvoicePreview> {
    const json = await this.#request('POST', '/v1/invoices/create_preview', {
      customer: input.customerId,
      subscription: input.subscriptionId,
      subscription_details: {
        items: input.items.map((item) => ({
          id: item.id,
          price: item.id === undefined ? item.priceId : undefined,
          quantity: item.deleted === true ? undefined : item.quantity,
          deleted: item.deleted === true ? true : undefined,
        })),
        proration_behavior: 'create_prorations',
      },
    });
    const lines =
      isRecord(json['lines']) && Array.isArray(json['lines']['data']) ? json['lines']['data'] : [];
    const currency = json['currency'];
    const amountDue = json['amount_due'];
    if (typeof currency !== 'string' || typeof amountDue !== 'number') {
      throw new StripeError('invalid_response', 'Stripe invoice preview: amounts');
    }
    const next = json['next_payment_attempt'];
    return {
      currency: currency.toUpperCase(),
      amountDue,
      lines: lines.filter(isRecord).map((line) => ({
        amount: typeof line['amount'] === 'number' ? line['amount'] : 0,
        proration:
          line['proration'] === true || (isRecord(line['parent']) && isProration(line['parent'])),
      })),
      nextPaymentAttempt: typeof next === 'number' ? next : null,
    };
  }

  /**
   * B077's invoice mirror: the customer's newest `limit` (1 to 100) invoices, after
   * `startingAfter` if given, as Stripe sent them (B077's `parseStripeInvoice` reads them).
   */
  async listInvoices(
    customerId: string,
    page: { limit: number; startingAfter?: string },
  ): Promise<{ data: unknown[]; hasMore: boolean }> {
    if (!/^cus_[A-Za-z0-9]{1,250}$/.test(customerId)) {
      throw new StripeError('request', 'not a Stripe customer id');
    }
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100) {
      throw new StripeError('request', 'an invoice page holds 1 to 100 invoices');
    }
    if (page.startingAfter !== undefined && !/^in_[A-Za-z0-9]{1,250}$/.test(page.startingAfter)) {
      throw new StripeError('request', 'not a Stripe invoice id');
    }
    const json = await this.#request('GET', '/v1/invoices', {
      customer: customerId,
      limit: page.limit,
      starting_after: page.startingAfter,
    });
    const data = json['data'];
    if (!Array.isArray(data)) throw new StripeError('invalid_response', 'Stripe invoice list');
    return { data, hasMore: json['has_more'] === true };
  }

  /** B077: one invoice (`in_…`), as Stripe sent it. */
  async retrieveInvoice(id: string): Promise<unknown> {
    if (!/^in_[A-Za-z0-9]{1,250}$/.test(id)) {
      throw new StripeError('request', 'not a Stripe invoice id');
    }
    return this.#request('GET', `/v1/invoices/${id}`);
  }

  /**
   * B079: the active promotion codes with this code (Stripe matches it case-insensitively; one
   * code text may be active once per customer restriction), at most 10, their coupons'
   * `applies_to` and `currency_options` expanded, as Stripe sent them. A code Stripe cannot hold
   * (it takes letters, digits and dashes) is not asked about: none.
   */
  async findPromotionCodes(code: string): Promise<unknown[]> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(code)) return [];
    const json = await this.#request('GET', '/v1/promotion_codes', {
      code,
      active: true,
      limit: 10,
      expand: ['data.coupon.applies_to', 'data.coupon.currency_options'],
    });
    const data = json['data'];
    if (!Array.isArray(data)) throw new StripeError('invalid_response', 'Stripe promotion codes');
    return data;
  }

  /**
   * B079: promotion code `promo_…`, its coupon's `applies_to` and `currency_options` expanded, as
   * Stripe sent it.
   */
  async retrievePromotionCode(id: string): Promise<unknown> {
    if (!/^promo_[A-Za-z0-9]{1,250}$/.test(id)) {
      throw new StripeError('request', 'not a Stripe promotion code id');
    }
    return this.#request('GET', `/v1/promotion_codes/${id}`, {
      expand: ['coupon.applies_to', 'coupon.currency_options'],
    });
  }

  /**
   * B079: the subscription's discounts (`di_…`, with the `promo_…` each came from; expanded) and
   * its items' products (`prod_…`).
   */
  async subscriptionDiscounts(subscriptionId: string): Promise<{
    discounts: { id: string; promotionCodeId: string | null }[];
    productIds: string[];
  }> {
    if (!/^sub_[A-Za-z0-9]{1,250}$/.test(subscriptionId)) {
      throw new StripeError('request', 'not a Stripe subscription id');
    }
    const json = await this.#request('GET', `/v1/subscriptions/${subscriptionId}`, {
      expand: ['discounts'],
    });
    const idOf = (value: unknown): string | null => {
      const id = isRecord(value) ? value['id'] : value;
      return typeof id === 'string' ? id : null;
    };
    const discounts = Array.isArray(json['discounts']) ? json['discounts'] : [];
    const items =
      isRecord(json['items']) && Array.isArray(json['items']['data']) ? json['items']['data'] : [];
    return {
      discounts: discounts.flatMap((discount: unknown) => {
        const id = idOf(discount);
        if (id === null || !id.startsWith('di_')) return [];
        const promo = isRecord(discount) ? idOf(discount['promotion_code']) : null;
        return [
          { id, promotionCodeId: promo !== null && promo.startsWith('promo_') ? promo : null },
        ];
      }),
      productIds: items
        .map((item: unknown) =>
          idOf(isRecord(item) && isRecord(item['price']) ? item['price']['product'] : null),
        )
        .filter((id): id is string => id !== null),
    };
  }

  /**
   * B079: adds promotion code `promotionCodeId` to the subscription, keeping `keepDiscountIds`
   * (Stripe replaces the discount list it is given), with the caller's idempotency key.
   */
  async applyPromotionCode(
    input: { subscriptionId: string; promotionCodeId: string; keepDiscountIds: string[] },
    idempotencyKey: string,
  ): Promise<StripeSub> {
    if (!/^sub_[A-Za-z0-9]{1,250}$/.test(input.subscriptionId)) {
      throw new StripeError('request', 'not a Stripe subscription id');
    }
    const json = await this.#request(
      'POST',
      `/v1/subscriptions/${input.subscriptionId}`,
      {
        discounts: [
          ...input.keepDiscountIds.map((discount) => ({ discount })),
          { promotion_code: input.promotionCodeId },
        ],
      },
      idempotencyKey,
    );
    return parseStripeSubscription(json);
  }

  constructEvent(rawBody: string | Buffer, signature: string): StripeEvent {
    const { webhookSecret, webhookSecrets } = this.options.config;
    const secrets =
      webhookSecrets !== undefined && webhookSecrets.length > 0
        ? webhookSecrets
        : webhookSecret === null
          ? []
          : [webhookSecret];
    if (secrets.length === 0)
      throw new StripeError('not_configured', 'STRIPE_WEBHOOK_SECRET is not set');
    let timestamp: number | null = null;
    const candidates: string[] = [];
    for (const part of signature.split(',')) {
      const [key, value] = part.trim().split('=', 2);
      if (key === 't' && value !== undefined && /^\d{1,12}$/.test(value)) timestamp = Number(value);
      else if (key === 'v1' && value !== undefined && /^[0-9a-f]{64}$/.test(value))
        candidates.push(value);
    }
    if (timestamp === null || candidates.length === 0) {
      throw new StripeError('signature', 'the Stripe-Signature header is malformed');
    }
    const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
    const expected = secrets.map((secret) =>
      createHmac('sha256', secret.reveal()).update(`${timestamp}.`).update(body).digest(),
    );
    const matches = candidates.some((hex) => {
      const given = Buffer.from(hex, 'hex');
      return expected.some((digest) => timingSafeEqual(given, digest));
    });
    if (!matches) throw new StripeError('signature', 'the webhook signature does not verify');
    if (Math.abs(Math.floor(this.#clock() / 1000) - timestamp) > WEBHOOK_TOLERANCE_S) {
      throw new StripeError('signature', 'the webhook signature is too old');
    }
    let event: unknown;
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch {
      throw new StripeError('invalid_response', 'the webhook body is not JSON');
    }
    if (
      !isRecord(event) ||
      typeof event['id'] !== 'string' ||
      typeof event['type'] !== 'string' ||
      typeof event['created'] !== 'number' ||
      !isRecord(event['data'])
    ) {
      throw new StripeError('invalid_response', 'the webhook body is not a Stripe event');
    }
    return {
      id: event['id'],
      type: event['type'],
      created: event['created'],
      object: event['data']['object'],
    };
  }
}

const isProration = (parent: Record<string, unknown>): boolean => {
  const details = parent['subscription_item_details'];
  return isRecord(details) && details['proration'] === true;
};

function idOf(json: unknown, prefix: string): string {
  const id = isRecord(json) ? json['id'] : undefined;
  if (typeof id !== 'string' || !id.startsWith(prefix)) {
    throw new StripeError('invalid_response', `Stripe answered no ${prefix}… id`);
  }
  return id;
}

function urlOf(json: Record<string, unknown>): string {
  const url = json['url'];
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new StripeError('invalid_response', 'Stripe answered no https URL');
  }
  return url;
}
