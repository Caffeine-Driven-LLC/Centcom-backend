/**
 * Fixtures for the checkout and portal tests (B071): a Stripe fake that records every checkout and
 * portal call and answers one session per idempotency key (as Stripe does), with scripted
 * failures; and both routes on the workspace routes' plugin stack (B024 idempotency, B021 RBAC
 * over memberships, B036 audit) over B070's in-memory billing. Session URLs and Stripe ids are
 * built at run time.
 */
import { randomUUID } from 'node:crypto';
import type { Metrics } from '@centcom/core';
import {
  CheckoutService,
  type CheckoutConfig,
} from '../../../src/modules/billing/checkout/service.js';
import type { RedirectKind } from '../../../src/modules/billing/checkout/redirects.js';
import type {
  CheckoutInput,
  CheckoutSession,
  CreateCustomerInput,
  PortalInput,
  StripeError,
  StripeGateway,
  StripeSub,
} from '../../../src/modules/billing/stripe/gateway.js';
import type { PriceCatalog } from '../../../src/modules/billing/stripe/price-catalog.js';
import type { BillingContact } from '../../../src/modules/billing/subscriptions/repository.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import { checkoutRoutes } from '../../../src/routes/checkout/index.js';
import { portalRoutes } from '../../../src/routes/portal/index.js';
import { asUser, createWorkspace, workspacesApp } from '../../modules/workspaces/helpers.js';
import {
  catalog,
  contact,
  FakeStripe,
  memoryBilling,
  newId,
  stripeId,
} from '../subscriptions/helpers.js';

export { asUser, newId, stripeId };

/** The scope both routes need. */
export const WRITE = 'billing:write';

/** A hosted page URL as Stripe returns one. */
export const sessionUrl = (host = 'checkout.stripe.com'): string =>
  `https://${host}/c/pay/${stripeId('cs')}`;

/**
 * A Stripe fake recording checkout and portal calls, one session per idempotency key; customers
 * and everything else are B070's `FakeStripe` (`fake`).
 */
export class RecordingStripe implements StripeGateway {
  readonly fake = new FakeStripe();
  readonly checkouts: { input: CheckoutInput; key: string }[] = [];
  readonly portals: PortalInput[] = [];
  readonly sessions = new Map<string, CheckoutSession>();
  /** Failures the next checkout or portal calls throw, in order. */
  readonly sessionFailures: StripeError[] = [];
  /** `expires_at` (unix seconds) of new checkout sessions; none when undefined. */
  expiresAt: number | undefined = Math.floor(Date.UTC(2026, 9, 9, 12, 0, 0) / 1000);

  /** Customers created (B070's fake). */
  get creates(): FakeStripe['creates'] {
    return this.fake.creates;
  }

  createCustomer(input: CreateCustomerInput, key: string): Promise<{ id: string }> {
    return this.fake.createCustomer(input, key);
  }

  findCustomerByWorkspace(workspaceId: string): Promise<{ id: string } | null> {
    return this.fake.findCustomerByWorkspace(workspaceId);
  }

  retrieveSubscription(): Promise<StripeSub> {
    return this.fake.retrieveSubscription();
  }

  createCheckoutSession(input: CheckoutInput, key: string): Promise<CheckoutSession> {
    this.checkouts.push({ input, key });
    const failure = this.sessionFailures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    let session = this.sessions.get(key);
    if (session === undefined) {
      session = {
        url: sessionUrl(),
        ...(this.expiresAt === undefined ? {} : { expiresAt: this.expiresAt }),
      };
      this.sessions.set(key, session);
    }
    return Promise.resolve(session);
  }

  createPortalSession(input: PortalInput): Promise<{ url: string }> {
    this.portals.push(input);
    const failure = this.sessionFailures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve({ url: sessionUrl('billing.stripe.com') });
  }

  updateSubscriptionItems(): Promise<StripeSub> {
    return this.fake.updateSubscriptionItems();
  }

  previewInvoice(): Promise<never> {
    return this.fake.previewInvoice();
  }

  constructEvent(): never {
    return this.fake.constructEvent();
  }
}

/** Options of the test app. */
export interface CheckoutAppOptions {
  config?: Partial<CheckoutConfig>;
  catalog?: PriceCatalog;
  redirects?: (kind: RedirectKind) => string;
  metrics?: Metrics;
}

/** Both routes on the workspace routes' stack, with an owner and a workspace that can be billed. */
export async function checkoutApp(options: CheckoutAppOptions = {}) {
  const contacts: Record<string, BillingContact> = {};
  const billing = memoryBilling(contacts);
  const stripe = new RecordingStripe();
  let checkout: CheckoutService | undefined;
  const wapp = await workspacesApp({
    beforeReady: async (app, ctx) => {
      const service = new BillingService({
        repository: billing.repository,
        gateway: stripe,
        catalog: catalog(),
      });
      checkout = new CheckoutService({
        gateway: stripe,
        billing: service,
        repository: billing.repository,
        catalog: options.catalog ?? catalog(),
        config: { maxSeats: 500, ...options.config },
        ...(options.redirects === undefined ? {} : { redirects: options.redirects }),
        logger: ctx.captured.logger,
        metrics: options.metrics ?? ctx.recorded.metrics,
      });
      await app.register(checkoutRoutes, { checkout });
      await app.register(portalRoutes, { checkout });
    },
  });
  if (checkout === undefined) throw new Error('the routes did not register');
  const owner = newId('usr');
  wapp.store.addUser(owner);
  const ws = (await createWorkspace(wapp.app, owner)).id;
  contacts[ws] = contact();
  return { ...wapp, billing, stripe, checkout, contacts, owner, ws };
}

/** The headers of `userId` with `scopes`, and a fresh Idempotency-Key unless `key` says. */
export const caller = (
  userId: string,
  scopes = WRITE,
  key: string | null = randomUUID(),
): Record<string, string> => ({
  ...asUser(userId, scopes),
  ...(key === null ? {} : { 'idempotency-key': key }),
});

/** A valid checkout body. */
export const teamCheckout = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  plan: 'team',
  interval: 'month',
  currency: 'EUR',
  seats: 5,
  ...overrides,
});
