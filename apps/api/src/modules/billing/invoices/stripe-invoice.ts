/**
 * Stripe invoices as the invoice mirror reads them (B077).
 *
 * - `parseStripeInvoice` checks a Stripe invoice object (from the list API, a retrieve, or a
 *   webhook's `data.object`) and keeps only what the mirror stores: ids, number, status, amounts,
 *   tax, currency, dates and the two Stripe-hosted links. Never card data, customer details,
 *   payment ids, tax-rate ids or the rest of the payload.
 * - **Status:** Stripe's `draft`, `open`, `paid`, `void` and `uncollectible` are the contract's;
 *   anything else (a status Stripe adds later, or none) is `other`, which is stored but never
 *   listed (CT-API-BILLING's `Invoice.status` has no `other`).
 * - **Period:** the service period of the invoice's lines (earliest start, latest end), else the
 *   invoice's own `period_start`/`period_end` (which, for a subscription invoice, look back one
 *   period).
 * - **Tax:** the amount is the sum of `total_taxes` (API 2025-03-31.basil), else of
 *   `total_tax_amounts`, else `tax` (older versions); null when Stripe computed none. The tax rate
 *   summary keeps, per tax line (at most MAX_TAX_LINES), its amount, the taxable amount, whether
 *   it is inclusive, the taxability reason and the effective rate in basis points (integer
 *   arithmetic); never the tax-rate ids.
 * - **Version** (`stripe_version`, Unix seconds): the newest of the invoice's `created`, its status
 *   transitions and `readAt`: the reporting event's `created`, or the time a sync or a retrieve
 *   read the invoice (a snapshot is as new as its read).
 * - **`shouldReplace`** is the update rule the repository applies: a higher status always wins
 *   (Stripe only moves an invoice forward: draft, open, uncollectible, then paid or void, which
 *   are final); the same status is replaced only by a version that is not older and changes
 *   something; a lower or sideways status never.
 *
 * Owns: reading invoices and the update rule. Must not: keep or log a payload, a customer id or a
 * link.
 */
import type { Api } from '@centcom/contracts';
import { StripeError } from '../stripe/gateway.js';

/** An invoice status the contract lists (CT-API-BILLING `Invoice.status`). */
export type InvoiceStatus = Api.Invoice['status'];

/**
 * The rank of each contract status (a Record, so a status the contract adds fails to compile):
 * Stripe moves an invoice forward only, and paid and void are final.
 */
const STATUS_RANK: Readonly<Record<InvoiceStatus, number>> = {
  draft: 0,
  open: 1,
  uncollectible: 2,
  paid: 3,
  void: 3,
};

/** The contract's invoice statuses. */
export const INVOICE_STATUSES = Object.freeze(Object.keys(STATUS_RANK) as InvoiceStatus[]);

/** A stored status: the contract's, or `other` (never listed). */
export type MirrorStatus = InvoiceStatus | 'other';

/** A currency CT-IDS allows (v1, `Money.currency`); invoices in any other are not mirrored. */
export type InvoiceCurrency = Api.Money['currency'];

/** The contract's currencies (a Record, so a currency the contract adds fails to compile). */
const CURRENCIES: Readonly<Record<InvoiceCurrency, true>> = { USD: true, EUR: true };

/** The contract's currencies. */
export const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(CURRENCIES) as InvoiceCurrency[]);

/** The longest link kept. */
export const MAX_LINK_LENGTH = 2048;
/** The most tax lines kept in the summary (the amount always sums them all). */
export const MAX_TAX_LINES = 20;

/** One line of the tax rate summary. */
export interface TaxLine {
  /** Minor units. */
  amount: number;
  /** Minor units, when Stripe gives it. */
  taxable_amount: number | null;
  /** Whether the tax is included in the price, when Stripe says. */
  inclusive: boolean | null;
  /** Stripe's taxability reason (`standard_rated`, `reverse_charge`, …), when given. */
  reason: string | null;
  /** The effective rate in basis points (amount / taxable amount), when both are known. */
  rate_bps: number | null;
}

/**
 * The fields of a Stripe invoice object the mirror reads (Stripe API 2025-03-31.basil and older);
 * everything else is ignored. Callers hand over the object as Stripe sent it: it is checked here.
 */
export interface StripeInvoiceLike {
  object: 'invoice';
  /** `in_…`. */
  id: string;
  /** `cus_…`, or the expanded customer. */
  customer: string | { id: string };
  status: string | null;
  /** ISO 4217, lower case. */
  currency: string;
  amount_due: number;
  amount_paid: number;
  number?: string | null;
  /** Unix seconds. */
  created: number;
  period_start?: number;
  period_end?: number;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  status_transitions?: {
    finalized_at?: number | null;
    paid_at?: number | null;
    voided_at?: number | null;
    marked_uncollectible_at?: number | null;
  } | null;
  /** API 2025-03-31.basil. */
  total_taxes?:
    | {
        amount: number;
        taxable_amount?: number | null;
        tax_behavior?: string | null;
        taxability_reason?: string | null;
      }[]
    | null;
  /** Before basil. */
  total_tax_amounts?:
    { amount: number; taxable_amount?: number | null; inclusive?: boolean | null }[] | null;
  /** Before basil. */
  tax?: number | null;
  lines?: { data?: { period?: { start: number; end: number } | null }[] } | null;
}

/** An invoice as the mirror stores it (before it is given a workspace and an id). */
export interface ParsedInvoice {
  stripeInvoiceId: string;
  /** For finding the workspace; never stored or logged. */
  customerId: string;
  number: string | null;
  status: MirrorStatus;
  /** Stripe's status as sent (only for the warning about an unknown one). */
  stripeStatus: string | null;
  /** ISO 4217, upper case; possibly one the mirror does not keep (`isSupportedCurrency`). */
  currency: string;
  amountDue: number;
  amountPaid: number;
  tax: number | null;
  /** The tax rate summary, or null when Stripe computed no tax. */
  taxRates: TaxLine[] | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  createdAt: Date;
  paidAt: Date | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
  /** Unix seconds. */
  version: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const minor = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const date = (unix: number | null): Date | null => (unix === null ? null : new Date(unix * 1000));

const invalid = (what: string): StripeError =>
  new StripeError('invalid_response', `Stripe invoice: ${what}`);

/** Stripe's invoice status as stored: the contract's, else `other`. */
export function mapInvoiceStatus(status: unknown): MirrorStatus {
  return typeof status === 'string' && Object.hasOwn(STATUS_RANK, status)
    ? (status as InvoiceStatus)
    : 'other';
}

/** Whether `currency` (upper case) is one the mirror keeps. */
export const isSupportedCurrency = (currency: string): currency is InvoiceCurrency =>
  Object.hasOwn(CURRENCIES, currency);

/** An https link of at most MAX_LINK_LENGTH characters, else null (kept opaque, never fetched). */
function link(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_LINK_LENGTH) return null;
  if (!value.startsWith('https://') || /[\s<>"]/.test(value)) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** `amount / taxable` in basis points, rounded half up, in integers; null when unknown. */
function rateBps(amount: number, taxable: number | null): number | null {
  if (taxable === null || taxable <= 0 || amount < 0) return null;
  const bps = (BigInt(amount) * 10_000n + BigInt(taxable) / 2n) / BigInt(taxable);
  return bps <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bps) : null;
}

/** A short lower-case reason (`standard_rated`), else null. */
const reasonOf = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : null;

/** The tax amount and summary of a tax list, or nulls when it is not one (or holds none). */
function taxList(list: unknown, legacy: boolean): { tax: number | null; lines: TaxLine[] | null } {
  if (!Array.isArray(list) || list.length === 0) return { tax: null, lines: null };
  let sum = 0;
  const lines: TaxLine[] = [];
  for (const entry of list) {
    const amount = isRecord(entry) ? minor(entry['amount']) : null;
    if (amount === null || !isRecord(entry)) throw invalid('tax amount');
    sum += amount;
    if (lines.length >= MAX_TAX_LINES) continue;
    const taxable = minor(entry['taxable_amount']);
    const behaviour = entry['tax_behavior'];
    lines.push({
      amount,
      taxable_amount: taxable,
      inclusive: legacy
        ? typeof entry['inclusive'] === 'boolean'
          ? entry['inclusive']
          : null
        : behaviour === 'inclusive'
          ? true
          : behaviour === 'exclusive'
            ? false
            : null,
      reason: legacy ? null : reasonOf(entry['taxability_reason']),
      rate_bps: rateBps(amount, taxable),
    });
  }
  if (!Number.isSafeInteger(sum)) throw invalid('tax amount');
  return { tax: sum, lines };
}

/** The invoice's tax in minor units and its summary; nulls when Stripe computed none. */
function taxOf(raw: Record<string, unknown>): { tax: number | null; lines: TaxLine[] | null } {
  if (Array.isArray(raw['total_taxes'])) return taxList(raw['total_taxes'], false);
  if (Array.isArray(raw['total_tax_amounts'])) return taxList(raw['total_tax_amounts'], true);
  return { tax: minor(raw['tax']), lines: null };
}

/** The service period of the lines, else the invoice's own period. */
function periodOf(raw: Record<string, unknown>): { start: number | null; end: number | null } {
  const lines = isRecord(raw['lines']) ? raw['lines']['data'] : undefined;
  let start: number | null = null;
  let end: number | null = null;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const period = isRecord(line) && isRecord(line['period']) ? line['period'] : null;
      const s = seconds(period?.['start']);
      const e = seconds(period?.['end']);
      if (s === null || e === null || s > e) continue;
      start = start === null ? s : Math.min(start, s);
      end = end === null ? e : Math.max(end, e);
    }
  }
  if (start !== null && end !== null) return { start, end };
  const s = seconds(raw['period_start']);
  const e = seconds(raw['period_end']);
  return s !== null && e !== null && s <= e ? { start: s, end: e } : { start: null, end: null };
}

/** The `in_…` id and the `cus_…` customer of an invoice object, full or reduced (B072). */
export function invoiceRef(raw: unknown): { stripeInvoiceId: string; customerId: string } {
  if (!isRecord(raw) || (raw['object'] !== undefined && raw['object'] !== 'invoice')) {
    throw invalid('not an invoice');
  }
  const id = raw['id'];
  if (typeof id !== 'string' || !/^in_[A-Za-z0-9]{1,250}$/.test(id)) throw invalid('id');
  const customer = isRecord(raw['customer']) ? raw['customer']['id'] : raw['customer'];
  if (typeof customer !== 'string' || !/^cus_[A-Za-z0-9]{1,250}$/.test(customer)) {
    throw invalid('customer');
  }
  return { stripeInvoiceId: id, customerId: customer };
}

/**
 * The mirror's view of a Stripe invoice object; a StripeError (`invalid_response`) for anything
 * that is not one. `readAt` (Unix seconds) is when this state was current: the reporting event's
 * `created`, or the time it was read from Stripe. The version is never older than it.
 */
export function parseStripeInvoice(raw: unknown, readAt?: number): ParsedInvoice {
  if (!isRecord(raw) || raw['object'] !== 'invoice') throw invalid('not an invoice');
  const { stripeInvoiceId, customerId } = invoiceRef(raw);
  const currency = raw['currency'];
  if (typeof currency !== 'string' || !/^[a-zA-Z]{3}$/.test(currency)) throw invalid('currency');
  const amountDue = minor(raw['amount_due']);
  const amountPaid = minor(raw['amount_paid']);
  if (amountDue === null || amountDue < 0) throw invalid('amount_due');
  if (amountPaid === null || amountPaid < 0) throw invalid('amount_paid');
  const created = seconds(raw['created']);
  if (created === null) throw invalid('created');
  const number = raw['number'];
  const transitions = isRecord(raw['status_transitions']) ? raw['status_transitions'] : {};
  const paidAt = seconds(transitions['paid_at']);
  const version = Math.max(
    created,
    seconds(transitions['finalized_at']) ?? 0,
    paidAt ?? 0,
    seconds(transitions['voided_at']) ?? 0,
    seconds(transitions['marked_uncollectible_at']) ?? 0,
    seconds(readAt) ?? 0,
  );
  const period = periodOf(raw);
  const status = raw['status'];
  const tax = taxOf(raw);
  return {
    stripeInvoiceId,
    customerId,
    number: typeof number === 'string' && number.length > 0 && number.length <= 100 ? number : null,
    status: mapInvoiceStatus(status),
    stripeStatus: typeof status === 'string' ? status : null,
    currency: currency.toUpperCase(),
    amountDue,
    amountPaid,
    tax: tax.tax,
    taxRates: tax.lines,
    periodStart: date(period.start),
    periodEnd: date(period.end),
    createdAt: new Date(created * 1000),
    paidAt: date(paidAt),
    hostedUrl: link(raw['hosted_invoice_url']),
    pdfUrl: link(raw['invoice_pdf']),
    version,
  };
}

/** How far along a status is; paid and void are final, `other` is below every known status. */
export const statusRank = (status: MirrorStatus): number =>
  status === 'other' ? -1 : STATUS_RANK[status];

/** What the update rule compares. */
export interface InvoiceState {
  number: string | null;
  status: MirrorStatus;
  currency: string;
  amountDue: number;
  amountPaid: number;
  tax: number | null;
  taxRates: TaxLine[] | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  createdAt: Date;
  paidAt: Date | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
  version: number;
}

const sameTime = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

const sameLines = (a: TaxLine[] | null, b: TaxLine[] | null): boolean =>
  a === null || b === null
    ? a === b
    : a.length === b.length &&
      a.every((line, i) => {
        const other = b[i];
        return (
          other !== undefined &&
          line.amount === other.amount &&
          line.taxable_amount === other.taxable_amount &&
          line.inclusive === other.inclusive &&
          line.reason === other.reason &&
          line.rate_bps === other.rate_bps
        );
      });

/** Whether `next` and `stored` hold the same values (the version aside). */
export function sameState(stored: InvoiceState, next: InvoiceState): boolean {
  return (
    stored.number === next.number &&
    stored.status === next.status &&
    stored.currency === next.currency &&
    stored.amountDue === next.amountDue &&
    stored.amountPaid === next.amountPaid &&
    stored.tax === next.tax &&
    sameLines(stored.taxRates, next.taxRates) &&
    sameTime(stored.periodStart, next.periodStart) &&
    sameTime(stored.periodEnd, next.periodEnd) &&
    sameTime(stored.createdAt, next.createdAt) &&
    sameTime(stored.paidAt, next.paidAt) &&
    stored.hostedUrl === next.hostedUrl &&
    stored.pdfUrl === next.pdfUrl
  );
}

/**
 * The update rule: `next` replaces `stored` when its status is higher (Stripe only moves
 * invoices forward), or when the status is the same and `next` is not older and changes
 * something (or is newer). A lower or sideways status never replaces. The stored version becomes
 * the newer of the two.
 */
export function shouldReplace(stored: InvoiceState, next: InvoiceState): boolean {
  if (next.status !== stored.status) {
    return statusRank(next.status) > statusRank(stored.status);
  }
  if (next.version < stored.version) return false;
  return next.version > stored.version || !sameState(stored, next);
}
