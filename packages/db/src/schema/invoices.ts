/**
 * Table types of the invoice mirror (B077, migration 20260102003700_invoices.sql). Written by the
 * API's invoice repository (apps/api `modules/billing/invoices/repository.ts`): what the invoice
 * list shows and the stale-update guard, never card data, customer ids or Stripe payloads.
 */
import type { ColumnType } from 'kysely';
import type { BillingDb } from './billing.js';
import type { CreatedAt, UpdatedAt } from './core.js';

/** A column written once, at insert. */
type Fixed<T> = ColumnType<T, T, never>;

/** A `bigint` column: Postgres returns it as text; written as a number. */
type Int8<T extends null = never> = ColumnType<string | T, number | T, number | T>;

/** An invoice's status: the contract's, or `other` for a Stripe status it lacks (never listed). */
export type InvoiceMirrorStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'other';

/** One line of an invoice's tax rate summary (amounts in minor units; never a tax-rate id). */
export interface InvoiceTaxLine {
  amount: number;
  taxable_amount: number | null;
  inclusive: boolean | null;
  reason: string | null;
  rate_bps: number | null;
}

/** `invoices`: one row per Stripe invoice of a workspace. */
export interface InvoicesTable {
  /** The public, opaque id: a bare ULID (CT-IDS defines no invoice prefix). */
  id: Fixed<string>;
  workspace_id: Fixed<string>;
  /** Stripe's `in_…`; never shown. */
  stripe_invoice_id: Fixed<string>;
  number: string | null;
  status: InvoiceMirrorStatus;
  currency: 'USD' | 'EUR';
  amount_due_minor: Int8;
  amount_paid_minor: Int8;
  tax_minor: Int8<null>;
  /** The tax rate summary (B077 `TaxLine[]`): read as parsed JSON, written as JSON text. */
  tax_rates: ColumnType<InvoiceTaxLine[] | null, string | null, string | null>;
  period_start: Date | null;
  period_end: Date | null;
  /** When Stripe created the invoice: the list's order. */
  created_at: Date;
  paid_at: Date | null;
  /** Stripe-hosted page and PDF: opaque links, never fetched. */
  hosted_url: string | null;
  pdf_url: string | null;
  /** Unix seconds: the stale-update guard. */
  stripe_version: Int8;
  updated_at: UpdatedAt;
}

/** `invoice_syncs`: when the lazy sync last called Stripe for a workspace, and last succeeded. */
export interface InvoiceSyncsTable {
  workspace_id: Fixed<string>;
  attempted_at: Date;
  synced_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/** The invoice tables. */
export interface InvoicesDatabase {
  invoices: InvoicesTable;
  invoice_syncs: InvoiceSyncsTable;
}

/** Billing and the invoice mirror. */
export type InvoicesDb = BillingDb & InvoicesDatabase;
