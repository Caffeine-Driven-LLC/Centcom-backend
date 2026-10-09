/**
 * `applyInvoiceEvent` and `removeInvoice` (B077 acceptance 3 and 4, test plan
 * "idempotency/out-of-order tests for applyInvoiceEvent", failure mode "invoice references an
 * unknown workspace"):
 *
 * - the same invoice applied twice leaves the row as the first call wrote it (same id, same
 *   values, same write time); an older version (a late event) changes nothing; a paid invoice
 *   never goes back to open, even when the late update claims to be newer;
 * - an invoice of a customer no workspace has is dropped: no row, an error log without the
 *   customer id, a count, and B070's `BillingStateError('unknown_workspace')`, which B072's
 *   processor records as a `failed` event (its dead-letter path, replayable);
 * - an invoice in a currency other than USD or EUR is not stored and is counted in
 *   `invoices_unsupported_currency_total`;
 * - an unknown status is stored as `other` (with a warning) and not listed;
 * - a higher status wins even when its version is older (Stripe only moves invoices forward; a
 *   sync may have read the lower one later), and the newer version is kept;
 * - `refreshInvoice` stores what Stripe answers as of the time it was read;
 * - `removeInvoice` drops a draft Stripe deleted, from B072's reduced object, only in the
 *   workspace of the invoice's customer, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { InvoiceService } from '../../../src/modules/billing/invoices/service.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import { BillingStateError } from '../../../src/modules/billing/subscriptions/service.js';
import { reduceObject } from '../../../src/modules/billing/webhooks/handlers.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import { memoryBilling } from '../subscriptions/helpers.js';
import { FakeInvoiceStripe, invoiceOf, memoryInvoices, newId, stripeId } from './helpers.js';

function setup() {
  const billing = memoryBilling();
  const mirror = memoryInvoices();
  const captured = captureLogger();
  const recorded = recordingMetrics();
  let now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const stripe = new FakeInvoiceStripe();
  const service = new InvoiceService({
    repository: mirror.repository,
    stripe,
    customers: billing.repository,
    clock: () => now,
    logger: captured.logger,
    metrics: recorded.metrics,
  });
  const ws = newId('wsp');
  const customer = stripeId('cus');
  billing.customers.set(ws, customer);
  const tick = (ms: number) => {
    now += ms;
  };
  return {
    billing,
    mirror,
    captured,
    recorded,
    service,
    stripe,
    ws,
    customer,
    tick,
    now: () => now,
  };
}

describe('applyInvoiceEvent', () => {
  it('stores an invoice once: a second call with the same invoice leaves the row unchanged', async () => {
    const { service, mirror, customer, ws, recorded, tick } = setup();
    const inv = invoiceOf('open-eur-vat', customer);
    await service.applyInvoiceEvent(inv);
    const first = await mirror.repository.find(ws, String(inv['id']));
    expect(first).toMatchObject({ workspaceId: ws, status: 'open', amountDue: 11305 });
    expect(first?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    tick(60_000);
    await service.applyInvoiceEvent(structuredClone(inv));
    expect(mirror.rows.get(String(inv['id']))).toEqual(first);
    expect(recorded.count('invoice_events_total', { outcome: 'written' })).toBe(1);
    expect(recorded.count('invoice_events_total', { outcome: 'unchanged' })).toBe(1);
  });

  it('ignores an out-of-order update with an older version', async () => {
    const { service, mirror, customer } = setup();
    const paid = invoiceOf('paid-usd-tax', customer);
    await service.applyInvoiceEvent(paid);
    const stored = mirror.rows.get(String(paid['id']));
    // The open state this invoice had before it was paid, delivered late.
    const late = {
      ...paid,
      status: 'open',
      amount_paid: 0,
      status_transitions: { finalized_at: 1790816400, paid_at: null },
    };
    await service.applyInvoiceEvent(late);
    expect(mirror.rows.get(String(paid['id']))).toEqual(stored);
  });

  it('never regresses paid to open, even when the update claims a newer version', async () => {
    const { service, mirror, customer } = setup();
    const paid = invoiceOf('paid-usd-tax', customer);
    await service.applyInvoiceEvent(paid, 1790816460);
    const open = { ...paid, status: 'open', amount_paid: 0 };
    await service.applyInvoiceEvent(open, 1790900000);
    expect(mirror.rows.get(String(paid['id']))).toMatchObject({ status: 'paid', amountPaid: 3190 });
    // Forward moves are taken: open, then paid.
    const other = invoiceOf('open-eur-vat', customer);
    await service.applyInvoiceEvent(other, 1791421200);
    await service.applyInvoiceEvent(
      {
        ...other,
        status: 'paid',
        amount_paid: 11305,
        status_transitions: { finalized_at: 1791421200, paid_at: 1791500000 },
      },
      1791500001,
    );
    expect(mirror.rows.get(String(other['id']))).toMatchObject({
      status: 'paid',
      amountPaid: 11305,
      version: 1791500001,
    });
  });

  it('keeps the public id and the workspace across updates', async () => {
    const { service, mirror, customer, ws } = setup();
    const inv = invoiceOf('uncollectible-usd', customer);
    await service.applyInvoiceEvent(inv);
    const id = mirror.rows.get(String(inv['id']))?.id;
    await service.applyInvoiceEvent({
      ...inv,
      status: 'paid',
      amount_paid: 2900,
      status_transitions: { finalized_at: 1786928400, paid_at: 1788200000 },
    });
    expect(mirror.rows.get(String(inv['id']))).toMatchObject({
      id,
      workspaceId: ws,
      status: 'paid',
    });
  });

  it('drops an invoice of an unknown customer: no row, an error log, B072 dead-letters it', async () => {
    const { service, mirror, captured, recorded } = setup();
    const stranger = stripeId('cus');
    const inv = invoiceOf('paid-usd-tax', stranger);
    const error = await service.applyInvoiceEvent(inv).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingStateError);
    expect((error as BillingStateError).reason).toBe('unknown_workspace');
    expect(mirror.rows.size).toBe(0);
    const line = captured.lines().find((l) => l['msg'] === 'invoice.unknown_customer');
    expect(line).toMatchObject({ level: 'error', stripe_invoice: inv['id'] });
    expect(captured.raw()).not.toContain(stranger);
    expect(recorded.count('invoice_events_total', { outcome: 'unknown_customer' })).toBe(1);
  });

  it('excludes an invoice in another currency and counts it', async () => {
    const { service, mirror, customer, recorded } = setup();
    await service.applyInvoiceEvent(invoiceOf('open-gbp', customer));
    expect(mirror.rows.size).toBe(0);
    expect(recorded.count('invoices_unsupported_currency_total', { source: 'event' })).toBe(1);
    expect(recorded.count('invoice_events_total', { outcome: 'unsupported_currency' })).toBe(1);
  });

  it('stores an unknown status as other, with a warning', async () => {
    const { service, mirror, customer, captured } = setup();
    const inv = invoiceOf('open-eur-vat', customer, { status: 'pending_review' });
    await service.applyInvoiceEvent(inv);
    expect(mirror.rows.get(String(inv['id']))?.status).toBe('other');
    expect(captured.lines().find((l) => l['msg'] === 'invoice.unknown_status')).toMatchObject({
      level: 'warn',
      stripe_status: 'pending_review',
    });
  });

  it('refuses what is not an invoice, as a Stripe invalid_response', async () => {
    const { service } = setup();
    const error = await service
      .applyInvoiceEvent({ object: 'subscription', id: 'sub_x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect((error as StripeError).kind).toBe('invalid_response');
  });

  it('never logs a customer id, a link or an amount', async () => {
    const { service, customer, captured } = setup();
    const inv = invoiceOf('paid-usd-tax', customer, { status: 'pending_review' });
    await service.applyInvoiceEvent(inv);
    await service.applyInvoiceEvent(invoiceOf('open-gbp', customer));
    const raw = captured.raw();
    expect(raw).not.toContain(customer);
    expect(raw).not.toMatch(/https:|3190|FIXTURE-/);
  });
});

describe('the status rule across sources', () => {
  it('takes a higher status even with an older version, keeping the newer version', async () => {
    const { service, mirror, customer } = setup();
    const inv = invoiceOf('open-eur-vat', customer);
    // A sync read the open invoice late (its version is the read time)...
    await service.applyInvoiceEvent(inv, 1799999999);
    // ...and the paid event, created before that read, arrives after it.
    await service.applyInvoiceEvent(
      {
        ...inv,
        status: 'paid',
        amount_paid: 11305,
        status_transitions: { finalized_at: 1791421200, paid_at: 1791500000 },
      },
      1791500001,
    );
    expect(mirror.rows.get(String(inv['id']))).toMatchObject({
      status: 'paid',
      amountPaid: 11305,
      version: 1799999999,
    });
  });
});

describe('refreshInvoice', () => {
  it('stores the invoice Stripe answers, as of the time it was read', async () => {
    const { service, stripe, mirror, customer, now } = setup();
    const inv = invoiceOf('draft-eur', customer, { created: Date.UTC(2026, 9, 1) / 1000 });
    stripe.add(customer, inv);
    await service.refreshInvoice(String(inv['id']));
    expect(mirror.rows.get(String(inv['id']))).toMatchObject({
      status: 'draft',
      version: Math.floor(now() / 1000),
    });
  });

  it('refuses when billing is off, and passes Stripe errors on', async () => {
    const { billing, mirror, service } = setup();
    const off = new InvoiceService({
      repository: mirror.repository,
      stripe: null,
      customers: billing.repository,
    });
    const error = await off.refreshInvoice('in_x').catch((e: unknown) => e);
    expect((error as StripeError).kind).toBe('not_configured');
    const missing = await service.refreshInvoice(stripeId('in')).catch((e: unknown) => e);
    expect((missing as StripeError).kind).toBe('request');
  });
});

describe('removeInvoice', () => {
  it('drops a draft Stripe deleted, from the reduced object B072 keeps, and never a finalized invoice', async () => {
    const { service, mirror, customer } = setup();
    const draft = invoiceOf('draft-eur', customer);
    const paid = invoiceOf('paid-usd-tax', customer);
    await service.applyInvoiceEvent(draft);
    await service.applyInvoiceEvent(paid);
    expect(await service.removeInvoice(reduceObject(paid))).toBe(false);
    expect(await service.removeInvoice(reduceObject(draft))).toBe(true);
    expect([...mirror.rows.keys()]).toEqual([paid['id']]);
  });

  it("removes only in the workspace of the invoice's customer", async () => {
    const { service, mirror, billing, customer } = setup();
    const draft = invoiceOf('draft-eur', customer);
    await service.applyInvoiceEvent(draft);
    const otherWs = newId('wsp');
    const otherCustomer = stripeId('cus');
    billing.customers.set(otherWs, otherCustomer);
    expect(await service.removeInvoice({ id: draft['id'], customer: otherCustomer })).toBe(false);
    expect(mirror.rows.has(String(draft['id']))).toBe(true);
    const error = await service
      .removeInvoice({ id: draft['id'], customer: stripeId('cus') })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingStateError);
    for (const bad of [
      { id: 'sub_x', customer },
      { id: draft['id'] },
      { object: 'charge' },
      null,
    ]) {
      const refused = await service.removeInvoice(bad).catch((e: unknown) => e);
      expect((refused as StripeError).kind).toBe('invalid_response');
    }
  });
});
