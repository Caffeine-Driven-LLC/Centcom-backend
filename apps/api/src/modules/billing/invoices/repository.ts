/**
 * The SQL of the invoice mirror (B077, migration 20260102003700).
 *
 * - `upsert` writes invoices by the update rule (`shouldReplace` in stripe-invoice.ts), in the
 *   statement itself: a higher status wins; the same status needs a version that is not older and
 *   a change; a lower or sideways status never, so concurrent writers (the webhook, two syncs)
 *   cannot move an invoice back. The stored version is the newer of the two. An invoice keeps its
 *   workspace and its public id.
 * - `list` pages a workspace's invoices newest first (`created_at`, then `id`), CT-PAGE keyset;
 *   `other` (a status the contract lacks) is never listed.
 * - Every statement names the workspace: in its WHERE (`workspace_id = $1`), or for the upsert in
 *   the row and its conflict guard. This is on top of the route's RBAC check.
 * - `claimSync` lets one caller per interval call Stripe for a workspace, across processes.
 * - `removeDrafts` drops drafts Stripe no longer has (Stripe deletes drafts; nothing else).
 *
 * Owns: the statements. Must not: store card data, customer ids or Stripe payloads.
 */
import { newId } from '@centcom/contracts';
import { paginate, type KeysetSpec, type Page, type PageParams } from '@centcom/core';
import type { InvoicesDb, InvoiceTaxLine } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import type { InvoiceState, MirrorStatus } from './stripe-invoice.js';

/** A stored invoice. */
export interface InvoiceRow extends InvoiceState {
  /** The public id: a bare ULID. */
  id: string;
  workspaceId: string;
  stripeInvoiceId: string;
}

/** The invoice mirror's persistence. */
export interface InvoiceRepository {
  /** Writes each row by the update rule at `at`; how many were inserted or replaced. */
  upsert(rows: readonly InvoiceRow[], at: Date): Promise<number>;
  /** One page of the workspace's listed invoices, newest first. */
  list(workspaceId: string, page: PageParams): Promise<Page<InvoiceRow>>;
  /** The workspace's stored invoice with this Stripe id, or null. */
  find(workspaceId: string, stripeInvoiceId: string): Promise<InvoiceRow | null>;
  /**
   * Deletes the workspace's drafts whose Stripe ids are not in `keep`, created after `since` (all
   * of them when null) and written before `writtenBefore`; how many.
   */
  removeDrafts(
    workspaceId: string,
    keep: readonly string[],
    window: { since: Date | null; writtenBefore: Date },
  ): Promise<number>;
  /** Deletes the workspace's invoice with this Stripe id if it is a draft; whether one was. */
  removeDraft(workspaceId: string, stripeInvoiceId: string): Promise<boolean>;
  /**
   * Claims the workspace's sync at `now` unless one was attempted after `now - intervalMs`.
   * Returns whether this caller claimed it, the latest attempt (this one when claimed), and when
   * a sync last succeeded (null: never).
   */
  claimSync(
    workspaceId: string,
    now: Date,
    intervalMs: number,
  ): Promise<{ claimed: boolean; attemptedAt: Date; syncedAt: Date | null }>;
  /** Records that the workspace's sync succeeded at `at`. */
  recordSynced(workspaceId: string, at: Date): Promise<void>;
}

/** The list's keyset: `created_at` desc, then `id` desc. */
export const INVOICE_KEYSET: KeysetSpec = {
  sorts: { created: { column: 'created_at', direction: 'desc' } },
};

/** The public id of a new invoice: a bare ULID (CT-IDS defines no invoice prefix). */
export const newInvoiceId = (): string => newId('req').slice('req_'.length);

const COLUMNS = [
  'id',
  'workspace_id',
  'stripe_invoice_id',
  'number',
  'status',
  'currency',
  'amount_due_minor',
  'amount_paid_minor',
  'tax_minor',
  'tax_rates',
  'period_start',
  'period_end',
  'created_at',
  'paid_at',
  'hosted_url',
  'pdf_url',
  'stripe_version',
] as const;

type Selected = {
  id: string;
  workspace_id: string;
  stripe_invoice_id: string;
  number: string | null;
  status: MirrorStatus;
  currency: 'USD' | 'EUR';
  amount_due_minor: string;
  amount_paid_minor: string;
  tax_minor: string | null;
  tax_rates: InvoiceTaxLine[] | null;
  period_start: Date | null;
  period_end: Date | null;
  created_at: Date;
  paid_at: Date | null;
  hosted_url: string | null;
  pdf_url: string | null;
  stripe_version: string;
};

const rowOf = (r: Selected): InvoiceRow => ({
  id: r.id,
  workspaceId: r.workspace_id,
  stripeInvoiceId: r.stripe_invoice_id,
  number: r.number,
  status: r.status,
  currency: r.currency,
  amountDue: Number(r.amount_due_minor),
  amountPaid: Number(r.amount_paid_minor),
  tax: r.tax_minor === null ? null : Number(r.tax_minor),
  taxRates: r.tax_rates,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  createdAt: r.created_at,
  paidAt: r.paid_at,
  hostedUrl: r.hosted_url,
  pdfUrl: r.pdf_url,
  version: Number(r.stripe_version),
});

/** A status's rank in SQL, as `statusRank` has it. */
const rank = (column: 'excluded.status' | 'invoices.status') =>
  sql`(case ${sql.ref(column)} when 'draft' then 0 when 'open' then 1 when 'uncollectible' then 2 when 'paid' then 3 when 'void' then 3 else -1 end)`;

/** The columns an update replaces (the guard compares them too). */
const UPDATED = [
  'number',
  'status',
  'currency',
  'amount_due_minor',
  'amount_paid_minor',
  'tax_minor',
  'tax_rates',
  'period_start',
  'period_end',
  'created_at',
  'paid_at',
  'hosted_url',
  'pdf_url',
] as const;

const rowList = (table: 'excluded' | 'invoices') =>
  sql.join(UPDATED.map((column) => sql.ref(`${table}.${column}`)));

/** The repository on Postgres. */
export function createInvoiceRepository<DB extends InvoicesDb>(
  database: Kysely<DB>,
): InvoiceRepository {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<InvoicesDb>;

  return {
    async upsert(rows, at) {
      // One statement may not touch a row twice: of two rows for one invoice, keep the one the
      // rule prefers (Stripe sends each invoice once per page, so this is rare).
      const byInvoice = new Map<string, InvoiceRow>();
      for (const row of rows) {
        const seen = byInvoice.get(row.stripeInvoiceId);
        if (seen === undefined || row.version >= seen.version)
          byInvoice.set(row.stripeInvoiceId, row);
      }
      if (byInvoice.size === 0) return 0;
      const written = await db
        .insertInto('invoices')
        .values(
          [...byInvoice.values()].map((row) => ({
            id: row.id,
            workspace_id: row.workspaceId,
            stripe_invoice_id: row.stripeInvoiceId,
            number: row.number,
            status: row.status,
            currency: row.currency as 'USD' | 'EUR',
            amount_due_minor: row.amountDue,
            amount_paid_minor: row.amountPaid,
            tax_minor: row.tax,
            tax_rates: row.taxRates === null ? null : JSON.stringify(row.taxRates),
            period_start: row.periodStart,
            period_end: row.periodEnd,
            created_at: row.createdAt,
            paid_at: row.paidAt,
            hosted_url: row.hostedUrl,
            pdf_url: row.pdfUrl,
            stripe_version: row.version,
            updated_at: at,
          })),
        )
        .onConflict((oc) =>
          oc
            .column('stripe_invoice_id')
            .doUpdateSet((eb) => ({
              number: eb.ref('excluded.number'),
              status: eb.ref('excluded.status'),
              currency: eb.ref('excluded.currency'),
              amount_due_minor: eb.ref('excluded.amount_due_minor'),
              amount_paid_minor: eb.ref('excluded.amount_paid_minor'),
              tax_minor: eb.ref('excluded.tax_minor'),
              tax_rates: eb.ref('excluded.tax_rates'),
              period_start: eb.ref('excluded.period_start'),
              period_end: eb.ref('excluded.period_end'),
              created_at: eb.ref('excluded.created_at'),
              paid_at: eb.ref('excluded.paid_at'),
              hosted_url: eb.ref('excluded.hosted_url'),
              pdf_url: eb.ref('excluded.pdf_url'),
              stripe_version: sql<number>`greatest(${sql.ref('excluded.stripe_version')}, ${sql.ref('invoices.stripe_version')})`,
              updated_at: eb.ref('excluded.updated_at'),
            }))
            .where(
              sql<boolean>`${sql.ref('invoices.workspace_id')} = ${sql.ref('excluded.workspace_id')}
                and (${rank('excluded.status')} > ${rank('invoices.status')}
                  or (${sql.ref('excluded.status')} = ${sql.ref('invoices.status')}
                    and ${sql.ref('excluded.stripe_version')} >= ${sql.ref('invoices.stripe_version')}
                    and (${sql.ref('excluded.stripe_version')} > ${sql.ref('invoices.stripe_version')}
                      or row(${rowList('invoices')}) is distinct from row(${rowList('excluded')}))))`,
            ),
        )
        .returning('id')
        .execute();
      return written.length;
    },

    async list(workspaceId, page) {
      const result = await paginate(
        db
          .selectFrom('invoices')
          .select(COLUMNS)
          .where('workspace_id', '=', workspaceId)
          .where('status', '<>', 'other'),
        INVOICE_KEYSET,
        page,
      );
      return { ...result, data: result.data.map(rowOf) };
    },

    async find(workspaceId, stripeInvoiceId) {
      const row = await db
        .selectFrom('invoices')
        .select(COLUMNS)
        .where('workspace_id', '=', workspaceId)
        .where('stripe_invoice_id', '=', stripeInvoiceId)
        .executeTakeFirst();
      return row === undefined ? null : rowOf(row);
    },

    async removeDrafts(workspaceId, keep, window) {
      let query = db
        .deleteFrom('invoices')
        .where('workspace_id', '=', workspaceId)
        .where('status', '=', 'draft')
        .where('updated_at', '<', window.writtenBefore);
      if (keep.length > 0) query = query.where('stripe_invoice_id', 'not in', [...keep]);
      if (window.since !== null) query = query.where('created_at', '>', window.since);
      const result = await query.executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    async removeDraft(workspaceId, stripeInvoiceId) {
      const result = await db
        .deleteFrom('invoices')
        .where('workspace_id', '=', workspaceId)
        .where('stripe_invoice_id', '=', stripeInvoiceId)
        .where('status', '=', 'draft')
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },

    async claimSync(workspaceId, now, intervalMs) {
      const claimed = await db
        .insertInto('invoice_syncs')
        .values({ workspace_id: workspaceId, attempted_at: now })
        .onConflict((oc) =>
          oc
            .column('workspace_id')
            .doUpdateSet({ attempted_at: now, updated_at: now })
            .where('invoice_syncs.attempted_at', '<=', new Date(now.getTime() - intervalMs)),
        )
        .returning(['attempted_at', 'synced_at'])
        .executeTakeFirst();
      if (claimed !== undefined) {
        return { claimed: true, attemptedAt: claimed.attempted_at, syncedAt: claimed.synced_at };
      }
      const row = await db
        .selectFrom('invoice_syncs')
        .select(['attempted_at', 'synced_at'])
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return {
        claimed: false,
        attemptedAt: row?.attempted_at ?? now,
        syncedAt: row?.synced_at ?? null,
      };
    },

    async recordSynced(workspaceId, at) {
      await db
        .updateTable('invoice_syncs')
        .set({ synced_at: at, updated_at: at })
        .where('workspace_id', '=', workspaceId)
        .execute();
    },
  };
}
