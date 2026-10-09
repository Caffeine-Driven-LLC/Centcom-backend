/**
 * Paging the invoice list (B077 acceptance 1 and 2, test plan "pagination with cursor stability
 * under concurrent inserts", failure mode "cursor invalid or expired -> 400 problem+json per
 * CT-PAGE"):
 *
 * - newest first: `created_at` desc, then id desc;
 * - `limit=2` over 5 invoices gives 2, 2 and 1, with `has_more` and `next_cursor` until the last
 *   page (`has_more: false`, `next_cursor: null`);
 * - a cursor is bound to its workspace: used on another workspace's list (another filter) it is a
 *   400 `cursor_invalid`, as is one older than 24 h, a forged one and a malformed one; all are
 *   problem+json;
 * - `limit` must be 1 to 200 (else 422), default 50; offsets are refused;
 * - invoices that arrive between pages never make one repeat or go missing;
 * - an invoice with a status the contract lacks (`other`) is never listed.
 */
import { describe, expect, it } from 'vitest';
import { invoiceOf, listAs, paidAt, unix, withWorkspace } from './helpers.js';
import { createWorkspace } from '../../modules/workspaces/helpers.js';
import { stripeId } from '../subscriptions/helpers.js';

interface PageBody {
  data: { id: string; created_at: string; number?: string; status: string }[];
  next_cursor: string | null;
  has_more: boolean;
}

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

async function withFive() {
  let now = NOW;
  const ctx = await withWorkspace({ clock: () => now });
  // Five invoices, a month apart; Stripe has them too, so the lazy sync changes nothing.
  const invoices = [1, 2, 3, 4, 5].map((month) => ({
    ...paidAt(ctx.customer, unix(2026, month, 1)),
    number: `N-${month}`,
  }));
  ctx.stripe.add(ctx.customer, ...invoices);
  for (const inv of invoices) await ctx.service.applyInvoiceEvent(inv);
  const advance = (ms: number) => {
    now += ms;
  };
  return { ...ctx, invoices, advance };
}

describe('GET /v1/workspaces/{id}/invoices: paging', () => {
  it('walks 5 invoices 2 at a time, newest first, then stops', async () => {
    const ctx = await withFive();
    const first = await listAs(ctx, ctx.ws, ctx.owner, 'limit=2');
    expect(first.statusCode).toBe(200);
    const page1 = first.json<PageBody>();
    expect(page1.data.map((i) => i.number)).toEqual(['N-5', 'N-4']);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toEqual(expect.any(String));

    const page2 = (
      await listAs(ctx, ctx.ws, ctx.owner, `limit=2&cursor=${page1.next_cursor}`)
    ).json<PageBody>();
    expect(page2.data.map((i) => i.number)).toEqual(['N-3', 'N-2']);
    expect(page2.has_more).toBe(true);

    const page3 = (
      await listAs(ctx, ctx.ws, ctx.owner, `limit=2&cursor=${page2.next_cursor}`)
    ).json<PageBody>();
    expect(page3.data.map((i) => i.number)).toEqual(['N-1']);
    expect(page3).toMatchObject({ has_more: false, next_cursor: null });
    await ctx.app.close();
  });

  it('breaks ties on created_at by id, descending', async () => {
    const ctx = await withWorkspace();
    const created = unix(2026, 6, 1);
    for (let i = 0; i < 4; i += 1) {
      await ctx.service.applyInvoiceEvent(paidAt(ctx.customer, created));
    }
    const ids = (await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>().data.map((i) => i.id);
    expect(ids).toHaveLength(4);
    expect(ids).toEqual([...ids].sort().reverse());
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: PageBody = (
        await listAs(ctx, ctx.ws, ctx.owner, `limit=1${cursor === null ? '' : `&cursor=${cursor}`}`)
      ).json<PageBody>();
      walked.push(...page.data.map((i) => i.id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(walked).toEqual(ids);
    await ctx.app.close();
  });

  it('refuses a cursor from another workspace, an expired one, a forged one: 400 cursor_invalid', async () => {
    const ctx = await withFive();
    const cursor = (await listAs(ctx, ctx.ws, ctx.owner, 'limit=2')).json<PageBody>().next_cursor;
    const other = (await createWorkspace(ctx.app, ctx.owner, 'Other')).id;
    ctx.billing.customers.set(other, stripeId('cus'));

    const elsewhere = await listAs(ctx, other, ctx.owner, `limit=2&cursor=${cursor}`);
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(elsewhere.json<{ code: string }>().code).toBe('cursor_invalid');

    const [keyId, payload, signature] = String(cursor).split('.');
    const forged = `${keyId}.${payload}.${String(signature).slice(1)}A`;
    for (const bad of [forged, 'not-a-cursor', 'a.b.c', '%%%']) {
      const response = await listAs(ctx, ctx.ws, ctx.owner, `cursor=${encodeURIComponent(bad)}`);
      expect(response.statusCode, bad).toBe(400);
      expect(response.json<{ code: string }>().code, bad).toBe('cursor_invalid');
    }

    ctx.advance(24 * 3_600_000 + 1_000);
    const expired = await listAs(ctx, ctx.ws, ctx.owner, `limit=2&cursor=${cursor}`);
    expect(expired.statusCode).toBe(400);
    expect(expired.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(expired.json<{ code: string }>().code).toBe('cursor_invalid');
    await ctx.app.close();
  });

  it('takes limit 1 to 200 (default 50) and refuses offsets with 422', async () => {
    const ctx = await withWorkspace();
    const created = unix(2026, 1, 1);
    for (let i = 0; i < 60; i += 1) {
      await ctx.service.applyInvoiceEvent(paidAt(ctx.customer, created + i * 3600));
    }
    expect((await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>().data).toHaveLength(50);
    expect((await listAs(ctx, ctx.ws, ctx.owner, 'limit=200')).json<PageBody>().data).toHaveLength(
      60,
    );
    expect((await listAs(ctx, ctx.ws, ctx.owner, 'limit=1')).json<PageBody>().data).toHaveLength(1);
    for (const query of [
      'limit=0',
      'limit=201',
      'limit=abc',
      'offset=10',
      'page=2',
      'sort=amount',
    ]) {
      const response = await listAs(ctx, ctx.ws, ctx.owner, query);
      expect(response.statusCode, query).toBe(422);
      expect(response.headers['content-type'], query).toMatch(/^application\/problem\+json/);
    }
    expect((await listAs(ctx, ctx.ws, ctx.owner, 'sort=created')).statusCode).toBe(200);
    await ctx.app.close();
  });

  it('neither repeats nor skips an invoice when new ones arrive between pages', async () => {
    const ctx = await withFive();
    const page1 = (await listAs(ctx, ctx.ws, ctx.owner, 'limit=2')).json<PageBody>();
    // Newer invoices, and one created between the pages' invoices, arrive meanwhile.
    await ctx.service.applyInvoiceEvent(paidAt(ctx.customer, unix(2026, 9, 1)));
    await ctx.service.applyInvoiceEvent({
      ...paidAt(ctx.customer, unix(2026, 3, 15)),
      number: 'N-3.5',
    });
    const rest: string[] = [];
    let cursor = page1.next_cursor;
    while (cursor !== null) {
      const page = (
        await listAs(ctx, ctx.ws, ctx.owner, `limit=2&cursor=${cursor}`)
      ).json<PageBody>();
      rest.push(...page.data.map((i) => String(i.number)));
      cursor = page.next_cursor;
    }
    expect([...page1.data.map((i) => String(i.number)), ...rest]).toEqual([
      'N-5',
      'N-4',
      'N-3.5',
      'N-3',
      'N-2',
      'N-1',
    ]);
    await ctx.app.close();
  });

  it('never lists an invoice whose status the contract lacks', async () => {
    const ctx = await withWorkspace();
    await ctx.service.applyInvoiceEvent(invoiceOf('open-eur-vat', ctx.customer));
    await ctx.service.applyInvoiceEvent(
      invoiceOf('paid-usd-tax', ctx.customer, { status: 'pending_review' }),
    );
    expect(ctx.mirror.rows.size).toBe(2);
    const body = (await listAs(ctx, ctx.ws, ctx.owner)).json<PageBody>();
    expect(body.data.map((i) => i.status)).toEqual(['open']);
    await ctx.app.close();
  });
});
