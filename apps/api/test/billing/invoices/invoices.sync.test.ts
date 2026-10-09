/**
 * The list's lazy sync (B077 acceptance 7, scope "lazy refresh syncInvoices(workspaceId) when the
 * mirror is older than 5 min", test plan "failure-path: Stripe 429/5xx during lazy sync returns
 * the stale mirror with 200 and logs a warning", failure mode "Stripe unreachable during lazy
 * sync", guardrail "MUST NOT block the response on Stripe availability"):
 *
 * - a first sync is waited for (at most the budget), so a first visit lists the invoices; a
 *   mirror that was synced before is served at once and refreshed in the background;
 * - 20 concurrent requests share one sync (single flight), and Stripe is called at most once per
 *   workspace per 5 minutes, also across two API processes sharing the database;
 * - when Stripe fails (429/5xx after B070's client retried, over HTTP), the list still answers
 *   200 with the mirror as it is, logs a warning and counts `invoice_sync_failed_total`; the next
 *   attempt waits out the interval;
 * - when Stripe stalls, the list answers from the mirror after the wait budget, and the sync's
 *   invoices show once it completes;
 * - a workspace without a Stripe customer, or with billing off, never calls Stripe;
 * - a draft Stripe deleted leaves the mirror, but never one written after the sync began;
 * - an invoice in another currency is counted and not shown.
 */
import { describe, expect, it } from 'vitest';
import { InvoiceService, SYNC_INTERVAL_MS } from '../../../src/modules/billing/invoices/service.js';
import { Secret } from '@centcom/core';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import {
  STRIPE_API_VERSION_DEFAULT,
  STRIPE_RETRIES,
  StripeClient,
} from '../../../src/modules/billing/stripe/stripe-client.js';
import { captureLogger, recordingMetrics } from '../../helpers.js';
import { memoryBilling, testSecretKey } from '../subscriptions/helpers.js';
import { createWorkspace } from '../../modules/workspaces/helpers.js';
import {
  FakeInvoiceStripe,
  invoiceOf,
  listAs,
  memoryInvoices,
  newId,
  paidAt,
  stripeId,
  unix,
  withWorkspace,
} from './helpers.js';

interface PageBody {
  data: { id: string; number?: string; status: string }[];
}

function clock(start = Date.UTC(2026, 9, 9, 12, 0, 0)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the lazy sync', () => {
  it('fills a stale mirror from one Stripe call', async () => {
    const time = clock();
    const ctx = await withWorkspace({ clock: time.now });
    ctx.stripe.add(
      ctx.customer,
      invoiceOf('paid-usd-tax', ctx.customer),
      invoiceOf('open-eur-vat', ctx.customer),
    );
    const body = (await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>();
    expect(body.data.map((i) => i.status)).toEqual(['open', 'paid']);
    expect(ctx.stripe.listCalls).toEqual([{ customerId: ctx.customer, limit: 100 }]);
    expect(ctx.mirror.syncs.get(ctx.ws)?.syncedAt?.getTime()).toBe(time.now());
    expect(ctx.recorded.count('invoice_syncs_total')).toBe(1);
    await ctx.app.close();
  });

  it('calls Stripe once for 20 concurrent requests, then not again for 5 minutes', async () => {
    const time = clock();
    const ctx = await withWorkspace({ clock: time.now });
    ctx.stripe.add(ctx.customer, invoiceOf('paid-usd-tax', ctx.customer));
    const release = ctx.stripe.stall();
    const pending = Array.from({ length: 20 }, () => listAs(ctx, ctx.ws, ctx.owner));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const responses = await Promise.all(pending);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses.every((r) => r.json<PageBody>().data.length === 1)).toBe(true);
    expect(ctx.stripe.listCalls).toHaveLength(1);

    time.advance(SYNC_INTERVAL_MS - 1_000);
    await Promise.all(Array.from({ length: 20 }, () => listAs(ctx, ctx.ws, ctx.owner)));
    expect(ctx.stripe.listCalls).toHaveLength(1);

    time.advance(1_000);
    await Promise.all(Array.from({ length: 20 }, () => listAs(ctx, ctx.ws, ctx.owner)));
    await ctx.service.idle();
    expect(ctx.stripe.listCalls).toHaveLength(2);
    await ctx.app.close();
  });

  it('shares the interval across processes through the database claim', async () => {
    const time = clock();
    const mirror = memoryInvoices();
    const billing = memoryBilling();
    const stripe = new FakeInvoiceStripe();
    const ws = newId('wsp');
    const customer = stripeId('cus');
    billing.customers.set(ws, customer);
    stripe.add(customer, invoiceOf('paid-usd-tax', customer));
    const processes = [1, 2].map(
      () =>
        new InvoiceService({
          repository: mirror.repository,
          stripe,
          customers: billing.repository,
          clock: time.now,
        }),
    );
    const page = { limit: 50, sort: 'created', filterHash: 'h', keys: [], now: time.now() };
    await Promise.all(
      processes.flatMap((service) => Array.from({ length: 10 }, () => service.list(ws, page))),
    );
    expect(stripe.listCalls).toHaveLength(1);
    time.advance(SYNC_INTERVAL_MS);
    await Promise.all(processes.map((service) => service.list(ws, page)));
    await Promise.all(processes.map((service) => service.idle()));
    expect(stripe.listCalls).toHaveLength(2);
  });

  it('answers 200 from the stale mirror when Stripe fails, with a warning and a count', async () => {
    const time = clock();
    const ctx = await withWorkspace({ clock: time.now });
    await ctx.service.applyInvoiceEvent(invoiceOf('paid-usd-tax', ctx.customer));
    ctx.stripe.add(ctx.customer, invoiceOf('open-eur-vat', ctx.customer));
    ctx.stripe.failures.push(
      new StripeError('unavailable', 'Stripe unavailable after 4 attempts (status 429)'),
    );
    const response = await listAs(ctx, ctx.ws, ctx.owner);
    expect(response.statusCode).toBe(200);
    expect(response.json<PageBody>().data.map((i) => i.status)).toEqual(['paid']);
    expect(response.body).not.toMatch(/error|unavailable/i);
    const warning = ctx.captured.lines().find((l) => l['msg'] === 'invoice.sync_failed');
    expect(warning).toMatchObject({ level: 'warn', reason: 'stripe_unavailable' });
    expect(ctx.recorded.count('invoice_sync_failed_total', { reason: 'stripe_unavailable' })).toBe(
      1,
    );

    // A 4xx that Stripe refuses outright, after the interval: still 200, counted by its reason.
    time.advance(SYNC_INTERVAL_MS);
    ctx.stripe.failures.push(new StripeError('request', 'Stripe refused the request (400)', 400));
    expect((await listAs(ctx, ctx.ws, ctx.owner)).statusCode).toBe(200);
    expect(ctx.recorded.count('invoice_sync_failed_total', { reason: 'stripe_error' })).toBe(1);

    // Not retried within the interval; once it passes, the next sync catches up.
    expect(ctx.stripe.listCalls).toHaveLength(2);
    await listAs(ctx, ctx.ws, ctx.owner);
    expect(ctx.stripe.listCalls).toHaveLength(2);
    time.advance(SYNC_INTERVAL_MS);
    const caught = (await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>();
    expect(caught.data.map((i) => i.status)).toEqual(['open', 'paid']);
    await ctx.app.close();
  });

  it('answers 200 from the mirror when Stripe keeps answering 429 and 5xx over HTTP', async () => {
    const time = clock();
    const billing = memoryBilling();
    const mirror = memoryInvoices();
    const captured = captureLogger();
    const recorded = recordingMetrics();
    const statuses = [429, 503, 500, 502];
    const calls: string[] = [];
    const client = new StripeClient({
      config: {
        secretKey: new Secret(testSecretKey()),
        apiVersion: STRIPE_API_VERSION_DEFAULT,
        webhookSecret: null,
        apiBase: 'https://stripe.test',
      },
      fetch: (input) => {
        calls.push(new URL(String(input)).pathname);
        return Promise.resolve(new Response('{}', { status: statuses[calls.length - 1] ?? 503 }));
      },
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    });
    const service = new InvoiceService({
      repository: mirror.repository,
      stripe: client,
      customers: billing.repository,
      clock: time.now,
      logger: captured.logger,
      metrics: recorded.metrics,
    });
    const ws = newId('wsp');
    const customer = stripeId('cus');
    billing.customers.set(ws, customer);
    await service.applyInvoiceEvent(invoiceOf('paid-usd-tax', customer));
    const page = await service.list(ws, {
      limit: 50,
      sort: 'created',
      filterHash: 'h',
      keys: [],
      now: time.now(),
    });
    expect(page.data.map((i) => i.status)).toEqual(['paid']);
    expect(calls).toEqual(Array.from({ length: STRIPE_RETRIES + 1 }, () => '/v1/invoices'));
    expect(captured.lines().find((l) => l['msg'] === 'invoice.sync_failed')).toMatchObject({
      level: 'warn',
      reason: 'stripe_unavailable',
    });
    expect(recorded.count('invoice_sync_failed_total', { reason: 'stripe_unavailable' })).toBe(1);
  });

  it('serves a synced mirror at once, and refreshes it in the background', async () => {
    const time = clock();
    const ctx = await withWorkspace({ clock: time.now, syncWaitMs: 10_000 });
    ctx.stripe.add(ctx.customer, invoiceOf('void-usd', ctx.customer));
    expect((await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>().data).toHaveLength(1);
    time.advance(SYNC_INTERVAL_MS);
    ctx.stripe.add(ctx.customer, invoiceOf('open-eur-vat', ctx.customer));
    const release = ctx.stripe.stall();
    const started = performance.now();
    const stale = await listAs(ctx, ctx.ws, ctx.owner);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(stale.json<PageBody>().data.map((i) => i.status)).toEqual(['void']);
    release();
    await ctx.service.idle();
    const fresh = (await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>();
    expect(fresh.data.map((i) => i.status)).toEqual(['open', 'void']);
    expect(ctx.stripe.listCalls).toHaveLength(2);
    await ctx.app.close();
  });

  it('answers from the mirror after the wait budget while Stripe stalls', async () => {
    const time = clock();
    const ctx = await withWorkspace({ clock: time.now, syncWaitMs: 30 });
    await ctx.service.applyInvoiceEvent(invoiceOf('void-usd', ctx.customer));
    ctx.stripe.add(ctx.customer, invoiceOf('open-eur-vat', ctx.customer));
    const release = ctx.stripe.stall();
    const started = performance.now();
    const response = await listAs(ctx, ctx.ws, ctx.owner);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(response.statusCode).toBe(200);
    expect(response.json<PageBody>().data.map((i) => i.status)).toEqual(['void']);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = (await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>();
    expect(later.data.map((i) => i.status)).toEqual(['open', 'void']);
    expect(ctx.stripe.listCalls).toHaveLength(1);
    await ctx.app.close();
  });

  it('never calls Stripe for a workspace without a customer, or with billing off', async () => {
    const ctx = await withWorkspace();
    const bare = (await createWorkspace(ctx.app, ctx.owner, 'No customer')).id;
    expect((await listAs(ctx, bare, ctx.owner)).statusCode).toBe(200);
    expect(ctx.stripe.listCalls).toHaveLength(0);
    await ctx.app.close();

    const off = await withWorkspace({ billingOff: true });
    await off.service.applyInvoiceEvent(invoiceOf('paid-usd-tax', off.customer));
    const response = await listAs(off, off.ws, off.owner);
    expect(response.json<PageBody>().data).toHaveLength(1);
    expect(off.mirror.syncs.size).toBe(0);
    await off.app.close();
  });

  it('drops drafts Stripe deleted, but not one written after the sync began', async () => {
    const time = clock();
    const ctx = await withWorkspace({ clock: time.now });
    const kept = invoiceOf('draft-eur', ctx.customer);
    const deleted = invoiceOf('draft-eur', ctx.customer);
    const paid = paidAt(ctx.customer, unix(2026, 9, 1));
    await ctx.service.applyInvoiceEvent(kept);
    await ctx.service.applyInvoiceEvent(deleted);
    await ctx.service.applyInvoiceEvent(paid);
    ctx.stripe.add(ctx.customer, kept, paid);
    time.advance(1_000);
    // A webhook's new draft lands while the sync's Stripe call is out.
    const release = ctx.stripe.stall();
    const listing = listAs(ctx, ctx.ws, ctx.owner);
    await new Promise((resolve) => setTimeout(resolve, 10));
    time.advance(1_000);
    const fresh = invoiceOf('draft-eur', ctx.customer);
    await ctx.service.applyInvoiceEvent(fresh);
    release();
    await listing;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([...ctx.mirror.rows.keys()].sort()).toEqual(
      [kept['id'], paid['id'], fresh['id']].map(String).sort(),
    );
    await ctx.app.close();
  });

  it('keeps drafts when the page holds an invoice it cannot read', async () => {
    const ctx = await withWorkspace();
    const draft = invoiceOf('draft-eur', ctx.customer);
    await ctx.service.applyInvoiceEvent(draft);
    ctx.stripe.add(ctx.customer, { ...invoiceOf('paid-usd-tax', ctx.customer), amount_due: 'x' });
    await listAs(ctx, ctx.ws, ctx.owner);
    expect(ctx.mirror.rows.has(String(draft['id']))).toBe(true);
    expect(ctx.captured.lines().some((l) => l['msg'] === 'invoice.unreadable')).toBe(true);
    await ctx.app.close();
  });

  it('counts and hides an invoice in another currency', async () => {
    const ctx = await withWorkspace();
    ctx.stripe.add(
      ctx.customer,
      invoiceOf('open-gbp', ctx.customer),
      invoiceOf('paid-usd-tax', ctx.customer),
    );
    const body = (await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>();
    expect(body.data.map((i) => i.status)).toEqual(['paid']);
    expect(ctx.recorded.count('invoices_unsupported_currency_total', { source: 'sync' })).toBe(1);
    await ctx.app.close();
  });
});
