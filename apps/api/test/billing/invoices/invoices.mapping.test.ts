/**
 * Stripe invoice objects to the mirror and to the public `Invoice` (B077 test plan "unit:
 * Stripe-to-public mapping for all invoice statuses incl. unknown, tax present/absent, EUR and
 * USD, zero-total invoices"; acceptance 3, the integer Money part; guardrail "never return raw
 * Stripe objects"):
 *
 * - every Stripe status maps to the contract's, and anything else to `other`, which is never
 *   listed (CT-API-BILLING's `Invoice.status` has no `other`);
 * - tax is the sum of `total_taxes` (basil), else of `total_tax_amounts`, else `tax`, else null;
 *   the tax rate summary keeps amount, taxable amount, inclusive, reason and the rate in basis
 *   points per line, never a tax-rate id;
 * - amounts stay integer minor units with an upper-case ISO 4217 currency; the public invoice is
 *   the contract's `Invoice` (validated), with `amount_due`/`amount_paid` as `Money`, optional
 *   fields left out when Stripe has none (a draft), and nothing else;
 * - the version is the newest of `created`, the status transitions and the time it was read;
 * - the update rule takes a higher status whatever its version, and never a lower or sideways
 *   status, an older version of the same status, or a no-op write;
 * - anything that is not an invoice is a StripeError `invalid_response`.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { publicInvoice } from '../../../src/modules/billing/invoices/service.js';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import {
  isSupportedCurrency,
  mapInvoiceStatus,
  parseStripeInvoice,
  shouldReplace,
  statusRank,
  type InvoiceState,
  type MirrorStatus,
} from '../../../src/modules/billing/invoices/stripe-invoice.js';
import { fixture, FIXTURES, type FixtureName } from './helpers.js';

const INVOICE_KEYS = new Set([
  'id',
  'number',
  'status',
  'amount_due',
  'amount_paid',
  'period_start',
  'period_end',
  'created_at',
  'hosted_invoice_url',
  'pdf_url',
]);

const at = (unix: number): string => new Date(unix * 1000).toISOString();

/** A stored row of fixture `name` (as the mirror would hold it). */
const rowOf = (name: FixtureName) => {
  const parsed = parseStripeInvoice(fixture(name));
  return { ...parsed, id: '01JA3Z8K2M5N7P9Q0R1S2T3V4W', workspaceId: 'wsp_x' };
};

describe('parseStripeInvoice', () => {
  it('maps every Stripe status, and anything else to other', () => {
    for (const status of ['draft', 'open', 'paid', 'void', 'uncollectible']) {
      expect(mapInvoiceStatus(status)).toBe(status);
    }
    for (const status of ['pending_review', 'deleted', 'PAID', '', null, undefined, 3]) {
      expect(mapInvoiceStatus(status)).toBe('other');
    }
    const unknown = parseStripeInvoice({ ...fixture('paid-usd-tax'), status: 'pending_review' });
    expect(unknown.status).toBe('other');
    expect(unknown.stripeStatus).toBe('pending_review');
    expect(parseStripeInvoice({ ...fixture('paid-usd-tax'), status: null }).status).toBe('other');
  });

  it('reads a paid USD invoice with basil total_taxes', () => {
    const inv = parseStripeInvoice(fixture('paid-usd-tax'));
    expect(inv).toMatchObject({
      stripeInvoiceId: 'in_FixturePaidUsdTax',
      customerId: 'cus_FixtureCustomerA',
      number: 'FIXTURE-0001',
      status: 'paid',
      currency: 'USD',
      amountDue: 3190,
      amountPaid: 3190,
      tax: 290,
      hostedUrl: 'https://invoice.stripe.com/i/acct_FixtureAccount/test_FixturePaidUsdTax',
      pdfUrl: 'https://pay.stripe.com/invoice/acct_FixtureAccount/test_FixturePaidUsdTax/pdf',
      version: 1790816460,
    });
    // The service period of the lines, not the invoice's look-back period.
    expect(inv.periodStart?.toISOString()).toBe(at(1790812800));
    expect(inv.periodEnd?.toISOString()).toBe(at(1793491200));
    expect(inv.createdAt.toISOString()).toBe(at(1790812800));
    expect(inv.paidAt?.toISOString()).toBe(at(1790816460));
  });

  it('reads an open EUR invoice with VAT and an expanded customer', () => {
    const inv = parseStripeInvoice(fixture('open-eur-vat'));
    expect(inv).toMatchObject({
      customerId: 'cus_FixtureCustomerA',
      status: 'open',
      currency: 'EUR',
      amountDue: 11305,
      amountPaid: 0,
      tax: 1805,
      paidAt: null,
      version: 1791421200,
    });
  });

  it('reads tax as absent (null) or zero, and from older API versions', () => {
    expect(parseStripeInvoice(fixture('draft-eur')).tax).toBeNull();
    expect(parseStripeInvoice(fixture('void-usd')).tax).toBeNull();
    expect(parseStripeInvoice(fixture('zero-total-usd')).tax).toBe(0);
    const legacy = parseStripeInvoice(fixture('legacy-paid-usd'));
    expect(legacy.tax).toBe(145);
    const onlyTax = fixture('legacy-paid-usd');
    delete onlyTax['total_tax_amounts'];
    expect(parseStripeInvoice(onlyTax).tax).toBe(145);
    delete onlyTax['tax'];
    expect(parseStripeInvoice(onlyTax).tax).toBeNull();
  });

  it('summarises the tax rates per line, without tax-rate ids', () => {
    expect(parseStripeInvoice(fixture('paid-usd-tax')).taxRates).toEqual([
      {
        amount: 290,
        taxable_amount: 2900,
        inclusive: false,
        reason: 'standard_rated',
        rate_bps: 1000,
      },
    ]);
    expect(parseStripeInvoice(fixture('open-eur-vat')).taxRates).toEqual([
      {
        amount: 1805,
        taxable_amount: 9500,
        inclusive: false,
        reason: 'standard_rated',
        rate_bps: 1900,
      },
    ]);
    // Zero-rated: a line with no rate (nothing taxable).
    expect(parseStripeInvoice(fixture('zero-total-usd')).taxRates).toEqual([
      { amount: 0, taxable_amount: 0, inclusive: false, reason: 'zero_rated', rate_bps: null },
    ]);
    // Before basil: total_tax_amounts, with Stripe's inclusive flag and no reason.
    expect(parseStripeInvoice(fixture('legacy-paid-usd')).taxRates).toEqual([
      { amount: 145, taxable_amount: null, inclusive: false, reason: null, rate_bps: null },
    ]);
    expect(parseStripeInvoice(fixture('draft-eur')).taxRates).toBeNull();
    const inclusive = parseStripeInvoice({
      ...fixture('paid-usd-tax'),
      total_taxes: [
        { amount: 333, taxable_amount: 1667, tax_behavior: 'inclusive', taxability_reason: 'x y' },
        { amount: 1, taxable_amount: 3, tax_behavior: 'other' },
      ],
    });
    expect(inclusive.taxRates).toEqual([
      { amount: 333, taxable_amount: 1667, inclusive: true, reason: null, rate_bps: 1998 },
      { amount: 1, taxable_amount: 3, inclusive: null, reason: null, rate_bps: 3333 },
    ]);
    expect(JSON.stringify(inclusive)).not.toContain('txr_');
    const many = parseStripeInvoice({
      ...fixture('paid-usd-tax'),
      total_taxes: Array.from({ length: 25 }, () => ({ amount: 2, taxable_amount: 10 })),
    });
    expect(many.tax).toBe(50);
    expect(many.taxRates).toHaveLength(20);
  });

  it('reads a zero-total invoice as zero amounts, not missing ones', () => {
    const inv = parseStripeInvoice(fixture('zero-total-usd'));
    expect(inv).toMatchObject({ status: 'paid', amountDue: 0, amountPaid: 0, currency: 'USD' });
  });

  it('reads a draft: no number, no links, versioned by its creation', () => {
    const inv = parseStripeInvoice(fixture('draft-eur'));
    expect(inv).toMatchObject({
      status: 'draft',
      number: null,
      hostedUrl: null,
      pdfUrl: null,
      version: 1792022400,
    });
  });

  it('versions by the newest status transition, or the reporting event when newer', () => {
    expect(parseStripeInvoice(fixture('void-usd')).version).toBe(1789693200);
    expect(parseStripeInvoice(fixture('uncollectible-usd')).version).toBe(1788134400);
    expect(parseStripeInvoice(fixture('void-usd'), 1789700000).version).toBe(1789700000);
    expect(parseStripeInvoice(fixture('void-usd'), 1).version).toBe(1789693200);
  });

  it('falls back to the invoice period without line periods, and drops a bad one', () => {
    const inv = parseStripeInvoice(fixture('void-usd'));
    expect(inv.periodStart?.toISOString()).toBe(at(1789603200));
    expect(inv.periodEnd?.toISOString()).toBe(at(1789603200));
    const reversed = { ...fixture('void-usd'), period_start: 10, period_end: 5 };
    expect(parseStripeInvoice(reversed)).toMatchObject({ periodStart: null, periodEnd: null });
  });

  it('keeps only https links of sane length, opaque', () => {
    const base = fixture('paid-usd-tax');
    const bad = [
      'http://invoice.stripe.com/i/x',
      'javascript:alert(1)',
      'https://in valid',
      `https://invoice.stripe.com/${'a'.repeat(2048)}`,
      42,
    ];
    for (const value of bad) {
      expect(parseStripeInvoice({ ...base, hosted_invoice_url: value }).hostedUrl).toBeNull();
      expect(parseStripeInvoice({ ...base, invoice_pdf: value }).pdfUrl).toBeNull();
    }
  });

  it('flags the currencies the mirror does not keep', () => {
    expect(parseStripeInvoice(fixture('open-gbp')).currency).toBe('GBP');
    expect(isSupportedCurrency('GBP')).toBe(false);
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('EUR')).toBe(true);
  });

  it('refuses what is not an invoice', () => {
    const base = fixture('paid-usd-tax');
    const broken: unknown[] = [
      null,
      'in_x',
      [],
      { ...base, object: 'subscription' },
      { ...base, id: 'sub_x' },
      { ...base, id: 'in_' },
      { ...base, customer: null },
      { ...base, customer: 'usr_x' },
      { ...base, customer: { id: 7 } },
      { ...base, currency: 'dollars' },
      { ...base, amount_due: 1.5 },
      { ...base, amount_due: -1 },
      { ...base, amount_paid: '100' },
      { ...base, created: -5 },
      { ...base, created: undefined },
      { ...base, total_taxes: [{ amount: 'x' }] },
      { ...base, total_taxes: [{ amount: Number.MAX_SAFE_INTEGER }, { amount: 10 }] },
    ];
    for (const raw of broken) {
      const error = (() => {
        try {
          parseStripeInvoice(raw);
          return null;
        } catch (err) {
          return err;
        }
      })();
      expect(error, JSON.stringify(raw)?.slice(0, 80)).toBeInstanceOf(StripeError);
      expect((error as StripeError).kind).toBe('invalid_response');
    }
  });
});

describe('publicInvoice', () => {
  it('is the contract Invoice for every supported fixture, with integer Money', () => {
    for (const name of FIXTURES) {
      if (name === 'open-gbp') continue;
      const body = publicInvoice(rowOf(name));
      expect(validate('api/Invoice', body).ok, name).toBe(true);
      for (const key of Object.keys(body))
        expect(INVOICE_KEYS.has(key), `${name}: ${key}`).toBe(true);
      for (const amount of [body.amount_due, body.amount_paid]) {
        expect(Number.isInteger(amount.amount)).toBe(true);
        expect(['USD', 'EUR']).toContain(amount.currency);
      }
    }
  });

  it('shows a paid invoice with its links and period, and a draft without what it lacks', () => {
    expect(publicInvoice(rowOf('paid-usd-tax'))).toEqual({
      id: '01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      number: 'FIXTURE-0001',
      status: 'paid',
      amount_due: { amount: 3190, currency: 'USD' },
      amount_paid: { amount: 3190, currency: 'USD' },
      period_start: at(1790812800),
      period_end: at(1793491200),
      created_at: at(1790812800),
      hosted_invoice_url: 'https://invoice.stripe.com/i/acct_FixtureAccount/test_FixturePaidUsdTax',
      pdf_url: 'https://pay.stripe.com/invoice/acct_FixtureAccount/test_FixturePaidUsdTax/pdf',
    });
    expect(publicInvoice(rowOf('draft-eur'))).toEqual({
      id: '01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      status: 'draft',
      amount_due: { amount: 7900, currency: 'EUR' },
      amount_paid: { amount: 0, currency: 'EUR' },
      period_start: at(1792022400),
      period_end: at(1794700800),
      created_at: at(1792022400),
    });
  });

  it('never carries a Stripe id, a customer detail, a payment id or a tax breakdown', () => {
    for (const name of FIXTURES) {
      if (name === 'open-gbp') continue;
      const text = JSON.stringify(publicInvoice(rowOf(name)));
      expect(text, name).not.toMatch(/cus_|pi_|pm_|ch_|sub_|txr_|price_|il_|in_Fixture/);
      expect(text, name).not.toMatch(/@|Fixture (Corp|GmbH)|Springfield|us_ein|tax/);
    }
  });
});

describe('the update rule', () => {
  const state = (status: MirrorStatus, version: number, amountPaid = 0): InvoiceState => ({
    number: 'N-1',
    status,
    currency: 'USD',
    amountDue: 100,
    amountPaid,
    tax: null,
    taxRates: null,
    periodStart: null,
    periodEnd: null,
    createdAt: new Date(0),
    paidAt: null,
    hostedUrl: null,
    pdfUrl: null,
    version,
  });

  it('ranks draft < open < uncollectible < paid = void, and other below all', () => {
    expect(statusRank('other')).toBeLessThan(statusRank('draft'));
    expect(statusRank('draft')).toBeLessThan(statusRank('open'));
    expect(statusRank('open')).toBeLessThan(statusRank('uncollectible'));
    expect(statusRank('uncollectible')).toBeLessThan(statusRank('paid'));
    expect(statusRank('paid')).toBe(statusRank('void'));
  });

  it('takes newer or equal versions that move forward or change something', () => {
    expect(shouldReplace(state('open', 10), state('paid', 11, 100))).toBe(true);
    expect(shouldReplace(state('open', 10), state('paid', 10, 100))).toBe(true);
    expect(shouldReplace(state('uncollectible', 10), state('paid', 12, 100))).toBe(true);
    expect(shouldReplace(state('draft', 10), state('draft', 10, 5))).toBe(true);
    expect(shouldReplace(state('other', 10), state('open', 10))).toBe(true);
    // The same state reported by a newer event moves the guard forward.
    expect(shouldReplace(state('paid', 10, 100), state('paid', 11, 100))).toBe(true);
    // A higher status wins even when older: a sync may have read the lower one later.
    expect(shouldReplace(state('open', 20), state('paid', 10, 100))).toBe(true);
    expect(shouldReplace(state('draft', 20), state('open', 10))).toBe(true);
  });

  it('refuses an older version, a lower or sideways status, and a no-op', () => {
    expect(shouldReplace(state('paid', 10, 100), state('paid', 9, 50))).toBe(false);
    expect(shouldReplace(state('paid', 10, 100), state('open', 20))).toBe(false);
    expect(shouldReplace(state('paid', 10, 100), state('void', 20))).toBe(false);
    expect(shouldReplace(state('void', 10), state('paid', 20, 100))).toBe(false);
    expect(shouldReplace(state('open', 10), state('draft', 20))).toBe(false);
    expect(shouldReplace(state('open', 10), state('other', 20))).toBe(false);
    expect(shouldReplace(state('open', 10), state('open', 10))).toBe(false);
  });
});
