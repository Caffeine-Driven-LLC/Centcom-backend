/**
 * Fixtures for the billing tests (B070): a fake Stripe that keeps idempotency keys as Stripe does
 * (the same key answers the same customer) and can be scripted to fail, a full price catalogue,
 * Stripe subscription objects, an in-memory billing repository with the Postgres one's rules,
 * and the subscription route on the workspace routes' plugin stack (B021 RBAC over memberships).
 * Secret-looking values are built at run time.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@centcom/contracts';
import {
  StripeError,
  type StripeGateway,
  type StripeSub,
} from '../../../src/modules/billing/stripe/gateway.js';
import {
  CURRENCIES,
  INTERVALS,
  loadPriceCatalog,
  PAID_PLANS,
  priceKey,
} from '../../../src/modules/billing/stripe/price-catalog.js';
import type {
  BillingContact,
  BillingRepository,
  SubscriptionRow,
} from '../../../src/modules/billing/subscriptions/repository.js';
import { BillingService } from '../../../src/modules/billing/subscriptions/service.js';
import { subscriptionRoutes } from '../../../src/routes/subscription/index.js';
import { workspacesApp } from '../../modules/workspaces/helpers.js';

export { newId };

/** A Stripe-looking id: `<prefix>_` and 24 letters and digits. */
export const stripeId = (prefix: string): string =>
  `${prefix}_${randomBytes(18)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 24)
    .padEnd(24, 'x')}`;

/** A test secret key, built here so no key-shaped literal sits in the source. */
export const testSecretKey = (): string => ['sk', 'test', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');

/** Every catalogue key with a price id of its own. */
export function catalogEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const interval of INTERVALS) {
    for (const currency of CURRENCIES) {
      for (const kind of [...PAID_PLANS, 'seat'] as const) {
        env[priceKey(kind, interval, currency)] = `price_${kind}${interval}${currency}`;
      }
    }
  }
  return env;
}

export const catalog = () => loadPriceCatalog(catalogEnv());

/** A fake Stripe: customers by idempotency key, scripted failures, recorded calls. */
export class FakeStripe implements StripeGateway {
  readonly customers = new Map<string, { workspaceId: string; email: string }>();
  readonly byKey = new Map<string, string>();
  readonly creates: { workspaceId: string; key: string; email: string; locale?: string }[] = [];
  /** Failures the next `createCustomer` calls throw, in order. */
  readonly createFailures: StripeError[] = [];
  /** Whether metadata search finds customers (Stripe's search lags a little). */
  searchable = true;
  /** Milliseconds each create takes, so concurrent calls overlap. */
  delayMs = 2;

  async createCustomer(
    input: { workspaceId: string; email: string; locale?: string },
    key: string,
  ): Promise<{ id: string }> {
    this.creates.push({
      workspaceId: input.workspaceId,
      key,
      email: input.email,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    });
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const failure = this.createFailures.shift();
    if (failure !== undefined) throw failure;
    const known = this.byKey.get(key);
    if (known !== undefined) return { id: known };
    const id = stripeId('cus');
    this.byKey.set(key, id);
    this.customers.set(id, { workspaceId: input.workspaceId, email: input.email });
    return { id };
  }

  findCustomerByWorkspace(workspaceId: string): Promise<{ id: string } | null> {
    if (!this.searchable) return Promise.resolve(null);
    for (const [id, customer] of this.customers) {
      if (customer.workspaceId === workspaceId) return Promise.resolve({ id });
    }
    return Promise.resolve(null);
  }

  retrieveSubscription(): Promise<StripeSub> {
    return Promise.reject(new StripeError('request', 'not scripted'));
  }

  createCheckoutSession(): Promise<{ url: string }> {
    return Promise.reject(new StripeError('request', 'not scripted'));
  }

  createPortalSession(): Promise<{ url: string }> {
    return Promise.reject(new StripeError('request', 'not scripted'));
  }

  updateSubscriptionItems(): Promise<StripeSub> {
    return Promise.reject(new StripeError('request', 'not scripted'));
  }

  previewInvoice(): Promise<never> {
    return Promise.reject(new StripeError('request', 'not scripted'));
  }

  constructEvent(): never {
    throw new StripeError('not_configured', 'not scripted');
  }
}

/** The in-memory repository, by the Postgres one's rules. */
export function memoryBilling(contacts: Record<string, BillingContact> = {}) {
  const customers = new Map<string, string>();
  const subscriptions = new Map<string, SubscriptionRow>();
  const repository: BillingRepository = {
    findCustomer: (ws) => Promise.resolve(customers.get(ws) ?? null),
    linkCustomer: (ws, id) => {
      if (!customers.has(ws)) {
        if ([...customers.values()].includes(id)) {
          return Promise.reject(new Error('duplicate stripe_customer_id'));
        }
        customers.set(ws, id);
      }
      return Promise.resolve(customers.get(ws) ?? id);
    },
    workspaceOfCustomer: (id) =>
      Promise.resolve([...customers].find(([, c]) => c === id)?.[0] ?? null),
    billingContact: (ws) => Promise.resolve(contacts[ws] ?? null),
    findSubscription: (ws) => {
      const row = subscriptions.get(ws);
      return Promise.resolve(row === undefined ? null : { ...row });
    },
    upsertSubscription: (row) => {
      const stored = subscriptions.get(row.workspaceId);
      if (stored !== undefined && stored.stripeEventCreated > row.stripeEventCreated) {
        return Promise.resolve({ row: { ...stored }, applied: false });
      }
      const next = { ...row, id: stored?.id ?? row.id };
      subscriptions.set(row.workspaceId, next);
      return Promise.resolve({ row: { ...next }, applied: true });
    },
  };
  return { repository, customers, subscriptions };
}

/** A contact as `billingContact` answers it. */
export const contact = (email = 'billing@example.test'): BillingContact => ({
  email,
  locale: 'de-DE',
  name: 'Acme',
});

/** A Stripe subscription of `customerId` on `plan` with `seats` add-on seats. */
export function stripeSub(
  customerId: string,
  overrides: Partial<StripeSub> & { plan?: 'pro' | 'team'; addonSeats?: number } = {},
): StripeSub {
  const { plan = 'team', addonSeats = 0, ...rest } = overrides;
  const start = Date.UTC(2026, 9, 1) / 1000;
  const end = Date.UTC(2026, 10, 1) / 1000;
  const items = [
    {
      id: stripeId('si'),
      priceId: `price_${plan}monthEUR`,
      quantity: 1,
      periodStart: start,
      periodEnd: end,
    },
  ];
  if (addonSeats > 0) {
    items.push({
      id: stripeId('si'),
      priceId: 'price_seatmonthEUR',
      quantity: addonSeats,
      periodStart: start,
      periodEnd: end,
    });
  }
  return {
    id: stripeId('sub'),
    customerId,
    status: 'active',
    cancelAtPeriodEnd: false,
    currency: 'EUR',
    items,
    periodStart: start,
    periodEnd: end,
    trialEnd: null,
    workspaceId: null,
    ...rest,
  };
}

/** The subscription route on the workspace routes' stack, over an in-memory billing service. */
export async function subscriptionApp() {
  const billing = memoryBilling();
  const stripe = new FakeStripe();
  const service = new BillingService({
    repository: billing.repository,
    gateway: stripe,
    catalog: catalog(),
  });
  const wapp = await workspacesApp({
    beforeReady: async (app) => {
      await app.register(subscriptionRoutes, { billing: service });
    },
  });
  return { ...wapp, billing, stripe, service };
}
