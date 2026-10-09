/**
 * The invoice repository's statements (B077 guardrail "MUST enforce workspace scoping in the SQL
 * `WHERE workspace_id = $1` of every query, in addition to the RBAC check"), captured from a
 * scripted driver so they are checked everywhere, not only on Postgres (invoices.postgres.test.ts
 * runs them for real in CI's integration job):
 *
 * - every statement names the workspace: in its WHERE, or for the upsert in the row and its
 *   conflict guard (an invoice never moves to another workspace);
 * - the upsert's guard is the update rule (rank, version, a change) and keeps the newer version;
 *   the tax rate summary goes in as JSON; two rows of one invoice in a batch become one;
 * - the list never shows `other`, and reads bigint columns back as numbers;
 * - the sync claim reports the stored attempt and success when another caller holds it.
 */
import type { InvoicesDb } from '@centcom/db';
import type { CompiledQuery, Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createInvoiceRepository,
  newInvoiceId,
  type InvoiceRow,
} from '../../../src/modules/billing/invoices/repository.js';
import { scriptedDb, type Reply } from '../../modules/users/helpers.js';
import { KEYS } from '../../modules/workspaces/helpers.js';
import { newId } from './helpers.js';

const WS = newId('wsp');
const PUBLIC_ID = newInvoiceId();

const row = (overrides: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: PUBLIC_ID,
  workspaceId: WS,
  stripeInvoiceId: 'in_FixtureRepository',
  number: 'N-1',
  status: 'paid',
  currency: 'EUR',
  amountDue: 7900,
  amountPaid: 7900,
  tax: 1501,
  taxRates: [
    {
      amount: 1501,
      taxable_amount: 7900,
      inclusive: false,
      reason: 'standard_rated',
      rate_bps: 1900,
    },
  ],
  periodStart: new Date('2026-10-01T00:00:00.000Z'),
  periodEnd: new Date('2026-11-01T00:00:00.000Z'),
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  paidAt: new Date('2026-10-01T01:00:00.000Z'),
  hostedUrl: 'https://invoice.stripe.com/i/acct_X/test_Y',
  pdfUrl: null,
  version: 1790816460,
  ...overrides,
});

/** A repository over a scripted driver; `reply` answers each statement. */
function scripted(reply: (query: CompiledQuery) => Reply = () => ({})) {
  const queries: CompiledQuery[] = [];
  const { db } = scriptedDb((query) => {
    queries.push(query);
    return reply(query);
  });
  return { repository: createInvoiceRepository(db as unknown as Kysely<InvoicesDb>), queries };
}

describe('the invoice repository statements', () => {
  it('names the workspace in every statement', async () => {
    const { repository, queries } = scripted();
    await repository.upsert([row()], new Date());
    await repository.list(WS, { limit: 10, sort: 'created', filterHash: 'h', keys: KEYS, now: 0 });
    await repository.find(WS, 'in_x');
    await repository.removeDrafts(WS, ['in_a'], { since: new Date(0), writtenBefore: new Date() });
    await repository.removeDrafts(WS, [], { since: null, writtenBefore: new Date() });
    await repository.removeDraft(WS, 'in_x').catch(() => false);
    await repository.claimSync(WS, new Date(), 300_000);
    await repository.recordSynced(WS, new Date());
    expect(queries.length).toBeGreaterThanOrEqual(9);
    for (const query of queries) {
      const sql = query.sql;
      expect(sql, sql).toMatch(/"workspace_id"/);
      expect(query.parameters, sql).toContain(WS);
      if (!sql.startsWith('insert')) expect(sql, sql).toMatch(/where "workspace_id" = \$\d+/);
    }
    // The upsert's guard keeps an invoice in its workspace.
    expect(queries[0]?.sql).toContain('"invoices"."workspace_id" = "excluded"."workspace_id"');
  });

  it('writes by the update rule, the tax summary as JSON, one row per invoice', async () => {
    const { repository, queries } = scripted((q) =>
      q.sql.startsWith('insert') ? { rows: [{ id: 'x' }] } : {},
    );
    expect(await repository.upsert([], new Date())).toBe(0);
    expect(queries).toHaveLength(0);
    const written = await repository.upsert(
      [row({ version: 10, amountPaid: 1 }), row({ version: 12 }), row({ version: 11 })],
      new Date(),
    );
    expect(written).toBe(1);
    const [insert] = queries;
    const sql = insert?.sql ?? '';
    expect(sql).toContain('on conflict ("stripe_invoice_id") do update set');
    expect(sql).toContain('greatest("excluded"."stripe_version", "invoices"."stripe_version")');
    expect(sql).toMatch(/\(case "excluded"\."status" when 'draft' then 0 .* else -1 end\) >/s);
    expect(sql).toContain('"excluded"."stripe_version" >= "invoices"."stripe_version"');
    expect(sql).toMatch(
      /row\("invoices"\."number", .*"invoices"\."tax_rates".*\) is distinct from row\(/s,
    );
    // One row (of the three for this invoice, the newest), 18 columns.
    expect(insert?.parameters).toHaveLength(18);
    expect(insert?.parameters).toContain(12);
    expect(insert?.parameters).toContain(
      JSON.stringify([
        {
          amount: 1501,
          taxable_amount: 7900,
          inclusive: false,
          reason: 'standard_rated',
          rate_bps: 1900,
        },
      ]),
    );
    await repository.upsert([row({ tax: null, taxRates: null })], new Date());
    expect(queries[1]?.parameters.filter((p) => p === null).length).toBeGreaterThanOrEqual(3);
  });

  it('lists without other, reading bigints back as numbers', async () => {
    const stored = {
      id: PUBLIC_ID,
      workspace_id: WS,
      stripe_invoice_id: 'in_x',
      number: null,
      status: 'open',
      currency: 'USD',
      amount_due_minor: '2900',
      amount_paid_minor: '0',
      tax_minor: null,
      tax_rates: null,
      period_start: null,
      period_end: null,
      created_at: new Date('2026-10-01T00:00:00.000Z'),
      paid_at: null,
      hosted_url: null,
      pdf_url: null,
      stripe_version: '1790812800',
      __keyset_sort: '2026-10-01 00:00:00+00',
      __keyset_id: PUBLIC_ID,
    };
    const { repository, queries } = scripted(() => ({ rows: [stored] }));
    const page = await repository.list(WS, {
      limit: 10,
      sort: 'created',
      filterHash: 'h',
      keys: KEYS,
      now: 0,
    });
    expect(queries[0]?.sql).toContain('"status" <> $2');
    expect(queries[0]?.parameters).toContain('other');
    expect(queries[0]?.sql).toContain('order by "created_at" desc, "id" desc');
    expect(page.data).toEqual([
      expect.objectContaining({
        stripeInvoiceId: 'in_x',
        amountDue: 2900,
        amountPaid: 0,
        tax: null,
        taxRates: null,
        version: 1790812800,
      }),
    ]);
    expect(await repository.find(WS, 'in_x')).toMatchObject({ amountDue: 2900 });
  });

  it('claims a sync, or reports the attempt and success another caller holds', async () => {
    const attempted = new Date('2026-10-09T12:00:00.000Z');
    const synced = new Date('2026-10-09T11:00:00.000Z');
    const claimed = scripted((q) =>
      q.sql.startsWith('insert') ? { rows: [{ attempted_at: attempted, synced_at: synced }] } : {},
    );
    expect(await claimed.repository.claimSync(WS, attempted, 300_000)).toEqual({
      claimed: true,
      attemptedAt: attempted,
      syncedAt: synced,
    });
    expect(claimed.queries[0]?.sql).toContain('where "invoice_syncs"."attempted_at" <= $5');
    expect(claimed.queries[0]?.parameters[4]).toEqual(new Date(attempted.getTime() - 300_000));

    const held = scripted((q) =>
      q.sql.startsWith('select') ? { rows: [{ attempted_at: attempted, synced_at: null }] } : {},
    );
    expect(await held.repository.claimSync(WS, new Date(), 300_000)).toEqual({
      claimed: false,
      attemptedAt: attempted,
      syncedAt: null,
    });
    const now = new Date();
    const none = scripted();
    expect(await none.repository.claimSync(WS, now, 300_000)).toEqual({
      claimed: false,
      attemptedAt: now,
      syncedAt: null,
    });
  });

  it('removes drafts by workspace, inside the window only', async () => {
    const { repository, queries } = scripted(() => ({ affected: 2n }));
    const since = new Date('2026-06-01T00:00:00.000Z');
    expect(
      await repository.removeDrafts(WS, ['in_a', 'in_b'], { since, writtenBefore: since }),
    ).toBe(2);
    expect(queries[0]?.sql).toContain('"status" = $2');
    expect(queries[0]?.sql).toContain('"stripe_invoice_id" not in ($4, $5)');
    expect(queries[0]?.sql).toContain('"created_at" > $6');
    expect(await repository.removeDraft(WS, 'in_a')).toBe(true);
    expect(queries[1]?.sql).toBe(
      'delete from "invoices" where "workspace_id" = $1 and "stripe_invoice_id" = $2 and "status" = $3',
    );
  });
});
