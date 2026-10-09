/**
 * The invoice mirror on Postgres 16 (B077; DATABASE_URL, CI's integration job): the same rules
 * as the in-memory tests, in the repository's own statements.
 *
 * - The upsert applies the update rule in SQL: a replay changes nothing (not even `updated_at`),
 *   an older version or a lower status changes nothing, a forward move is applied, the public id
 *   and the workspace never change, an unknown status is stored as `other` and not listed, and a
 *   currency other than USD or EUR never reaches the table.
 * - The list pages newest first (ties by id), cursor by cursor, without repeats or gaps while
 *   invoices arrive between pages, and only for the workspace asked about.
 * - The sync claim lets one of 20 concurrent callers through per interval; 20 concurrent lists
 *   over a stale mirror call Stripe once.
 * - Draft removal keeps drafts outside its window and drafts written after the sync began.
 */
import type { InvoicesDb } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createInvoiceRepository,
  newInvoiceId,
} from '../../../src/modules/billing/invoices/repository.js';
import { InvoiceService, SYNC_INTERVAL_MS } from '../../../src/modules/billing/invoices/service.js';
import { createBillingRepository } from '../../../src/modules/billing/subscriptions/repository.js';
import { KEYS } from '../../modules/workspaces/helpers.js';
import {
  ADMIN_URL,
  migratedDatabase,
  pgUser,
  pgWorkspace,
} from '../../notifications/dispatcher/postgres.js';
import { FakeInvoiceStripe, invoiceOf, paidAt, stripeId, unix } from './helpers.js';

async function setup() {
  const t = await migratedDatabase(25);
  const db = t.db as unknown as Kysely<InvoicesDb>;
  const owner = await pgUser(t.db);
  const ws = await pgWorkspace(t.db, owner);
  const customers = createBillingRepository(db);
  const customer = stripeId('cus');
  await customers.linkCustomer(ws, customer);
  const repository = createInvoiceRepository(db);
  let now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const stripe = new FakeInvoiceStripe();
  const service = new InvoiceService({
    repository,
    stripe,
    customers,
    clock: () => now,
  });
  const advance = (ms: number) => {
    now += ms;
  };
  const page = (cursor?: string, limit = 2) => ({
    limit,
    sort: 'created',
    filterHash: ws,
    keys: KEYS,
    now,
    ...(cursor === undefined ? {} : { cursor }),
  });
  return { t, db, owner, ws, customers, customer, repository, service, stripe, advance, page };
}

describe.runIf(ADMIN_URL !== undefined)('the invoice mirror on Postgres 16', () => {
  it('applies the update rule in the upsert', async () => {
    const s = await setup();
    try {
      const paid = invoiceOf('paid-usd-tax', s.customer);
      await s.service.applyInvoiceEvent(paid);
      const first = await s.repository.find(s.ws, String(paid['id']));
      expect(first).toMatchObject({
        workspaceId: s.ws,
        status: 'paid',
        currency: 'USD',
        amountDue: 3190,
        amountPaid: 3190,
        tax: 290,
        taxRates: [
          {
            amount: 290,
            taxable_amount: 2900,
            inclusive: false,
            reason: 'standard_rated',
            rate_bps: 1000,
          },
        ],
        version: 1790816460,
      });
      expect(first?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      const stamp = async () =>
        (
          await s.db
            .selectFrom('invoices')
            .select('updated_at')
            .where('stripe_invoice_id', '=', String(paid['id']))
            .executeTakeFirstOrThrow()
        ).updated_at.getTime();
      const written = await stamp();

      // A replay, a late older state, and a "newer" open state: nothing changes.
      s.advance(60_000);
      await s.service.applyInvoiceEvent(structuredClone(paid));
      await s.service.applyInvoiceEvent({
        ...paid,
        status: 'open',
        amount_paid: 0,
        status_transitions: { finalized_at: 1790816400, paid_at: null },
      });
      await s.service.applyInvoiceEvent({ ...paid, status: 'open', amount_paid: 0 }, 1799999999);
      expect(await s.repository.find(s.ws, String(paid['id']))).toEqual(first);
      expect(await stamp()).toBe(written);

      // A forward move is applied, keeping the id.
      const owed = invoiceOf('uncollectible-usd', s.customer);
      await s.service.applyInvoiceEvent(owed);
      const owedId = (await s.repository.find(s.ws, String(owed['id'])))?.id;
      await s.service.applyInvoiceEvent({
        ...owed,
        status: 'paid',
        amount_paid: 2900,
        status_transitions: { finalized_at: 1786928400, paid_at: 1788200000 },
      });
      expect(await s.repository.find(s.ws, String(owed['id']))).toMatchObject({
        id: owedId,
        status: 'paid',
        amountPaid: 2900,
        version: 1788200000,
      });

      // A higher status wins even with an older version; the newer version stays.
      const late = invoiceOf('open-eur-vat', s.customer);
      await s.service.applyInvoiceEvent(late, 1799999999);
      await s.service.applyInvoiceEvent(
        {
          ...late,
          status: 'paid',
          amount_paid: 11305,
          status_transitions: { finalized_at: 1791421200, paid_at: 1791500000 },
        },
        1791500001,
      );
      expect(await s.repository.find(s.ws, String(late['id']))).toMatchObject({
        status: 'paid',
        amountPaid: 11305,
        version: 1799999999,
      });

      // Unknown status stored as other, not listed; GBP never stored.
      await s.service.applyInvoiceEvent(
        invoiceOf('open-eur-vat', s.customer, { status: 'pending_review' }),
      );
      await s.service.applyInvoiceEvent(invoiceOf('open-gbp', s.customer));
      const statuses = (
        await s.db.selectFrom('invoices').select(['status', 'currency']).execute()
      ).map((r) => `${r.status}/${r.currency}`);
      expect(statuses.sort()).toEqual(['other/EUR', 'paid/EUR', 'paid/USD', 'paid/USD']);
      const listed = await s.repository.list(s.ws, s.page(undefined, 50));
      expect(listed.data.map((r) => r.status)).toEqual(['paid', 'paid', 'paid']);
      // Scoped by workspace: another workspace finds and removes nothing of this one's.
      const elsewhere = await pgWorkspace(s.t.db, s.owner);
      expect(await s.repository.find(elsewhere, String(paid['id']))).toBeNull();

      // An invoice is never moved to another workspace.
      const ws2 = await pgWorkspace(s.t.db, s.owner);
      const row = await s.repository.find(s.ws, String(paid['id']));
      if (row === null) throw new Error('no row');
      expect(
        await s.repository.upsert(
          [
            {
              ...row,
              id: newInvoiceId(),
              workspaceId: ws2,
              version: row.version + 10,
              amountPaid: 1,
            },
          ],
          new Date(),
        ),
      ).toBe(0);
      expect((await s.repository.find(s.ws, String(paid['id'])))?.workspaceId).toBe(s.ws);
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('pages newest first, ties by id, without repeats or gaps while invoices arrive', async () => {
    const s = await setup();
    try {
      const months = [1, 2, 3, 4, 5];
      for (const month of months) {
        await s.service.applyInvoiceEvent({
          ...paidAt(s.customer, unix(2026, month, 1)),
          number: `N-${month}`,
        });
      }
      const tie = unix(2026, 2, 1);
      await s.service.applyInvoiceEvent({ ...paidAt(s.customer, tie), number: 'N-2b' });

      const page1 = await s.repository.list(s.ws, s.page());
      expect(page1.data.map((r) => r.number)).toEqual(['N-5', 'N-4']);
      expect(page1.has_more).toBe(true);
      // Arrivals: one newer than everything, one between the pages.
      await s.service.applyInvoiceEvent({ ...paidAt(s.customer, unix(2026, 9, 1)), number: 'N-9' });
      await s.service.applyInvoiceEvent({
        ...paidAt(s.customer, unix(2026, 3, 15)),
        number: 'N-3.5',
      });
      const rest: { number: string | null; id: string; created: number }[] = [];
      let cursor = page1.next_cursor;
      while (cursor !== null) {
        const next = await s.repository.list(s.ws, s.page(cursor));
        rest.push(
          ...next.data.map((r) => ({ number: r.number, id: r.id, created: r.createdAt.getTime() })),
        );
        cursor = next.next_cursor;
      }
      expect(rest.map((r) => r.number).filter((n) => n !== 'N-2' && n !== 'N-2b')).toEqual([
        'N-3.5',
        'N-3',
        'N-1',
      ]);
      // The two invoices created in the same second come id-descending.
      const tied = rest.filter((r) => r.created === tie * 1000);
      expect(tied).toHaveLength(2);
      expect(tied.map((r) => r.id)).toEqual(
        tied
          .map((r) => r.id)
          .sort()
          .reverse(),
      );

      // Another workspace sees none of them.
      const ws2 = await pgWorkspace(s.t.db, s.owner);
      expect((await s.repository.list(ws2, s.page())).data).toEqual([]);
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('lets one of 20 concurrent claims through per interval, and syncs once for 20 lists', async () => {
    const s = await setup();
    try {
      const at = new Date(Date.UTC(2026, 9, 9, 12));
      const claims = await Promise.all(
        Array.from({ length: 20 }, () => s.repository.claimSync(s.ws, at, SYNC_INTERVAL_MS)),
      );
      expect(claims.filter((c) => c.claimed)).toHaveLength(1);
      expect(claims.every((c) => c.attemptedAt.getTime() === at.getTime())).toBe(true);
      const later = new Date(at.getTime() + SYNC_INTERVAL_MS);
      expect((await s.repository.claimSync(s.ws, later, SYNC_INTERVAL_MS)).claimed).toBe(true);

      const ws2 = await pgWorkspace(s.t.db, s.owner);
      const customer2 = stripeId('cus');
      await s.customers.linkCustomer(ws2, customer2);
      s.stripe.add(
        customer2,
        invoiceOf('paid-usd-tax', customer2),
        invoiceOf('draft-eur', customer2),
      );
      const pages = await Promise.all(
        Array.from({ length: 20 }, () =>
          s.service.list(ws2, { ...s.page(undefined, 50), filterHash: ws2 }),
        ),
      );
      expect(s.stripe.listCalls).toHaveLength(1);
      expect(pages.every((p) => p.data.length === 2)).toBe(true);
      const sync = await s.db
        .selectFrom('invoice_syncs')
        .selectAll()
        .where('workspace_id', '=', ws2)
        .executeTakeFirstOrThrow();
      expect(sync.synced_at).not.toBeNull();
    } finally {
      await s.t.drop();
    }
  }, 60_000);

  it('removes only the drafts in its window that were written before the sync', async () => {
    const s = await setup();
    try {
      const old = invoiceOf('draft-eur', s.customer, { created: unix(2026, 1, 1) });
      const inWindow = invoiceOf('draft-eur', s.customer, { created: unix(2026, 6, 1) });
      const kept = invoiceOf('draft-eur', s.customer, { created: unix(2026, 6, 2) });
      const paid = paidAt(s.customer, unix(2026, 5, 1));
      for (const inv of [old, inWindow, kept, paid]) await s.service.applyInvoiceEvent(inv);
      s.advance(1_000);
      const before = new Date(Date.UTC(2026, 9, 9, 12, 0, 1));
      s.advance(1_000);
      const late = invoiceOf('draft-eur', s.customer, { created: unix(2026, 6, 3) });
      await s.service.applyInvoiceEvent(late);
      const removed = await s.repository.removeDrafts(s.ws, [String(kept['id'])], {
        since: new Date(unix(2026, 3, 1) * 1000),
        writtenBefore: before,
      });
      expect(removed).toBe(1);
      const left = (await s.db.selectFrom('invoices').select('stripe_invoice_id').execute())
        .map((r) => r.stripe_invoice_id)
        .sort();
      expect(left).toEqual([old, kept, paid, late].map((i) => String(i['id'])).sort());
      expect(await s.repository.removeDraft(s.ws, String(paid['id']))).toBe(false);
      expect(await s.repository.removeDraft(s.ws, String(old['id']))).toBe(true);
    } finally {
      await s.t.drop();
    }
  }, 60_000);
});
