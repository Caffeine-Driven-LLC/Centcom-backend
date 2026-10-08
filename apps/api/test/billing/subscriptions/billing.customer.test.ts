/**
 * Customers (B070 acceptance 1 and 5, failure modes, guardrail "idempotency key on every write"):
 * 20 concurrent `ensureCustomer` calls for one workspace make exactly one Stripe customer and all
 * get its id, in one process (one attempt shared) and across 20 (one idempotency key, so Stripe
 * answers the same customer, and one link); the key is derived from the workspace id and the
 * operation; the billing contact's e-mail and locale go to Stripe and nowhere else. A customer
 * Stripe already has (a link lost after the create) is found by its metadata and linked, not
 * duplicated. Stripe unavailable is 503 with `retry_after_s` and leaves no row; a refusal is 500.
 * On Postgres 16 (DATABASE_URL), 20 services at once leave one row.
 */
import { isAppError } from '@centcom/core';
import type { BillingDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { idempotencyKey, StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { createBillingRepository } from '../../../src/modules/billing/subscriptions/repository.js';
import {
  BillingService,
  STRIPE_RETRY_AFTER_S,
} from '../../../src/modules/billing/subscriptions/service.js';
import { pgJoin, pgUser, pgWorkspace } from '../../notifications/dispatcher/postgres.js';
import { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
import { catalog, contact, FakeStripe, memoryBilling, newId } from './helpers.js';

function service(billing = memoryBilling(), stripe = new FakeStripe()) {
  return {
    billing,
    stripe,
    service: new BillingService({
      repository: billing.repository,
      gateway: stripe,
      catalog: catalog(),
    }),
  };
}

describe('ensureCustomer', () => {
  it('makes one customer for 20 concurrent calls in one process', async () => {
    const ws = newId('wsp');
    const { service: s, stripe, billing } = service(memoryBilling({ [ws]: contact() }));
    const results = await Promise.all(Array.from({ length: 20 }, () => s.ensureCustomer(ws)));
    expect(new Set(results.map((r) => r.customerId)).size).toBe(1);
    expect(stripe.customers.size).toBe(1);
    expect(stripe.creates).toHaveLength(1);
    expect(billing.customers.get(ws)).toBe(results[0]?.customerId);
    // Later calls read the link and do not ask Stripe.
    expect(await s.ensureCustomer(ws)).toEqual(results[0]);
    expect(stripe.creates).toHaveLength(1);
  });

  it('makes one customer for 20 processes at once: one idempotency key, one link', async () => {
    const ws = newId('wsp');
    const billing = memoryBilling({ [ws]: contact() });
    const stripe = new FakeStripe();
    stripe.searchable = false; // Stripe's search lags behind a create.
    const services = Array.from({ length: 20 }, () => service(billing, stripe).service);
    const results = await Promise.all(services.map((s) => s.ensureCustomer(ws)));
    expect(new Set(results.map((r) => r.customerId)).size).toBe(1);
    expect(stripe.customers.size).toBe(1);
    expect(new Set(stripe.creates.map((c) => c.key))).toEqual(
      new Set([idempotencyKey(ws, 'customer-create')]),
    );
    expect(billing.customers.size).toBe(1);
  });

  it('derives the idempotency key from the workspace and operation, and sends the contact', async () => {
    const ws = newId('wsp');
    const { service: s, stripe } = service(memoryBilling({ [ws]: contact('pay@acme.test') }));
    await s.ensureCustomer(ws);
    expect(stripe.creates[0]).toEqual({
      workspaceId: ws,
      key: `centcom-${ws}-customer-create`,
      email: 'pay@acme.test',
      locale: 'de-DE',
    });
  });

  it('links a customer Stripe already has for the workspace instead of creating one', async () => {
    const ws = newId('wsp');
    const { service: s, stripe, billing } = service(memoryBilling({ [ws]: contact() }));
    const { id } = await stripe.createCustomer(
      { workspaceId: ws, email: 'x@example.test' },
      'earlier',
    );
    const before = stripe.creates.length;
    expect(await s.ensureCustomer(ws)).toEqual({ customerId: id });
    expect(stripe.creates).toHaveLength(before);
    expect(billing.customers.get(ws)).toBe(id);
  });

  it('answers 503 with retry_after_s when Stripe is unavailable, and stores nothing', async () => {
    const ws = newId('wsp');
    const { service: s, stripe, billing } = service(memoryBilling({ [ws]: contact() }));
    stripe.createFailures.push(
      new StripeError('unavailable', 'Stripe unavailable after 4 attempts'),
    );
    const error = await s.ensureCustomer(ws).catch((err: unknown) => err);
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'service_unavailable', retryAfterS: STRIPE_RETRY_AFTER_S });
    expect(billing.customers.size).toBe(0);
    // The next call creates it with the same key.
    const { customerId } = await s.ensureCustomer(ws);
    expect(billing.customers.get(ws)).toBe(customerId);
    expect(new Set(stripe.creates.map((c) => c.key)).size).toBe(1);
  });

  it('answers 500 when Stripe refuses the request, and 404 without a contact', async () => {
    const ws = newId('wsp');
    const { service: s, stripe } = service(memoryBilling({ [ws]: contact() }));
    stripe.createFailures.push(new StripeError('request', 'Stripe refused the request (400)', 400));
    await expect(s.ensureCustomer(ws)).rejects.toMatchObject({ code: 'internal_error' });
    await expect(service().service.ensureCustomer(newId('wsp'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe.runIf(ADMIN_URL !== undefined)('customers on Postgres 16', () => {
  it('leaves one row for 20 services at once, and finds the billing contact', async () => {
    const t = await migratedDatabase(25);
    try {
      const db = t.db as unknown as Kysely<BillingDb>;
      const owner = await pgUser(t.db);
      const payer = await pgUser(t.db);
      const ws = await pgWorkspace(t.db, owner);
      await pgJoin(t.db, ws, owner, 'owner');
      const repository = createBillingRepository(db);
      expect((await repository.billingContact(ws))?.email).toBe(
        `${owner.toLowerCase()}@example.test`,
      );
      await pgJoin(t.db, ws, payer, 'billing');
      expect((await repository.billingContact(ws))?.email).toBe(
        `${payer.toLowerCase()}@example.test`,
      );

      const stripe = new FakeStripe();
      stripe.searchable = false;
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          new BillingService({ repository, gateway: stripe, catalog: catalog() }).ensureCustomer(
            ws,
          ),
        ),
      );
      expect(new Set(results.map((r) => r.customerId)).size).toBe(1);
      const rows = await db.selectFrom('billing_customer').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.stripe_customer_id).toBe(results[0]?.customerId);
      expect(await repository.workspaceOfCustomer(results[0]?.customerId ?? '')).toBe(ws);
      // No e-mail is stored on Centcom's side.
      expect(JSON.stringify(rows)).not.toContain('@');
    } finally {
      await t.drop();
    }
  }, 60_000);
});
