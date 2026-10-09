/**
 * The invoice mirror (B077): a workspace's Stripe invoices kept locally, so the list is cheap to
 * page and keeps answering while Stripe is down.
 *
 * - **`applyInvoiceEvent(inv, readAt?)`** is the entry point for B072's webhook handler: it stores
 *   one Stripe invoice object by the update rule (a higher status wins; the same status needs a
 *   version that is not older and a change; never a lower status). An invoice of a customer no
 *   workspace has is dropped with an error log and a `BillingStateError('unknown_workspace')`,
 *   which B072's processor records as a `failed` event with `unknown_customer` (not retried;
 *   replayable once the link exists); no row is created. An invoice in a currency other than USD
 *   or EUR is not stored and is counted (`invoices_unsupported_currency_total`).
 * - **`refreshInvoice(id)`** retrieves one invoice from Stripe and stores it as of the time it was
 *   read: the one call B072's handler needs (it keeps only a reduced copy of each event).
 *   **`removeInvoice(inv)`** drops a deleted draft (B072's `invoice.deleted`; a reduced object
 *   with `id` and `customer` is enough).
 * - **`syncInvoices(workspaceId)`** reads the customer's newest invoices from Stripe (one call,
 *   SYNC_PAGE_SIZE of them), stores them as of the time they were read, and drops drafts Stripe
 *   deleted.
 * - **`list(workspaceId, page)`** answers from the mirror. When the workspace's last sync attempt
 *   is older than SYNC_INTERVAL_MS, it starts one lazy sync (single-flight per workspace in this
 *   process, and claimed in the database so concurrent processes share it: Stripe is called at
 *   most once per workspace per interval). A mirror that was synced before is served at once and
 *   refreshed in the background; only a workspace's first sync is waited for, at most
 *   `syncWaitMs`, so a first visit does not list nothing. A sync that fails or takes longer never
 *   fails the list: the mirror is served as it is, the failure is logged as a warning and counted
 *   (`invoice_sync_failed_total`).
 * - The public shape is the contract's `Invoice` (CT-API-BILLING): amounts as `Money`, the
 *   Stripe-hosted links, never a Stripe id, a customer id, card data or the tax (the contract has
 *   no tax field; the mirror keeps the amount and the rate summary for later).
 *
 * Owns: the mirror's rules. Must not: fetch the hosted links, log a customer id or a link, or
 * make a list wait on Stripe longer than `syncWaitMs`.
 */
import { formatTimestamp, money, type Api } from '@centcom/contracts';
import { noopMetrics, type Logger, type Metrics, type Page, type PageParams } from '@centcom/core';
import { StripeError } from '../stripe/gateway.js';
import { BillingStateError } from '../subscriptions/service.js';
import type { CustomerLinks, InvoiceStripe } from './ports.js';
import { newInvoiceId, type InvoiceRepository, type InvoiceRow } from './repository.js';
import {
  invoiceRef,
  isSupportedCurrency,
  parseStripeInvoice,
  type ParsedInvoice,
} from './stripe-invoice.js';

/** How long the mirror is fresh: no sync is attempted again for a workspace within it. */
export const SYNC_INTERVAL_MS = 5 * 60_000;
/** How long a list waits for a workspace's first sync before answering from the mirror. */
export const SYNC_WAIT_MS = 2_000;
/** The invoices one sync reads (one Stripe call; Stripe's largest page). */
export const SYNC_PAGE_SIZE = 100;
/** Workspaces whose last sync attempt this process remembers (beyond it, the database decides). */
export const MAX_REMEMBERED_WORKSPACES = 10_000;

/** What the service needs. */
export interface InvoiceServiceDeps {
  repository: InvoiceRepository;
  /** Null when billing is off (no Stripe key): the list then serves the mirror only. */
  stripe: InvoiceStripe | null;
  customers: CustomerLinks;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** How long a list waits for a first sync; default SYNC_WAIT_MS. */
  syncWaitMs?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/** Why a sync failed, as a metric label. */
function failureReason(err: unknown): string {
  if (err instanceof StripeError) {
    return err.kind === 'unavailable' ? 'stripe_unavailable' : 'stripe_error';
  }
  return 'error';
}

/** The contract's `Invoice` for a stored one (never `other`: those are not listed). */
export function publicInvoice(row: InvoiceRow): Api.Invoice {
  const currency = row.currency as Api.Money['currency'];
  return {
    id: row.id,
    ...(row.number === null ? {} : { number: row.number }),
    status: row.status as Api.Invoice['status'],
    amount_due: money(row.amountDue, currency),
    amount_paid: money(row.amountPaid, currency),
    ...(row.periodStart === null ? {} : { period_start: formatTimestamp(row.periodStart) }),
    ...(row.periodEnd === null ? {} : { period_end: formatTimestamp(row.periodEnd) }),
    created_at: formatTimestamp(row.createdAt),
    ...(row.hostedUrl === null ? {} : { hosted_invoice_url: row.hostedUrl }),
    ...(row.pdfUrl === null ? {} : { pdf_url: row.pdfUrl }),
  };
}

/** A parsed invoice as a row of `workspaceId` (the id is kept when the row exists). */
const rowOf = (workspaceId: string, inv: ParsedInvoice): InvoiceRow => ({
  id: newInvoiceId(),
  workspaceId,
  stripeInvoiceId: inv.stripeInvoiceId,
  number: inv.number,
  status: inv.status,
  currency: inv.currency,
  amountDue: inv.amountDue,
  amountPaid: inv.amountPaid,
  tax: inv.tax,
  taxRates: inv.taxRates,
  periodStart: inv.periodStart,
  periodEnd: inv.periodEnd,
  createdAt: inv.createdAt,
  paidAt: inv.paidAt,
  hostedUrl: inv.hostedUrl,
  pdfUrl: inv.pdfUrl,
  version: inv.version,
});

/** The invoice mirror. */
export class InvoiceService {
  readonly #clock: () => number;
  readonly #waitMs: number;
  readonly #metrics: Metrics;
  /** Workspace → when this process may next try a sync (milliseconds). */
  readonly #nextAttempt = new Map<string, number>();
  /** Workspace → the lazy sync claim (and first sync) in flight in this process. */
  readonly #inflight = new Map<string, Promise<void>>();
  /** Background refreshes of synced mirrors (at most one per workspace per interval). */
  readonly #background = new Set<Promise<void>>();

  constructor(private readonly deps: InvoiceServiceDeps) {
    this.#clock = deps.clock ?? Date.now;
    this.#waitMs = deps.syncWaitMs ?? SYNC_WAIT_MS;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Now, in Unix seconds. */
  #nowS(): number {
    return Math.floor(this.#clock() / 1000);
  }

  /** The workspace of a Stripe customer; an error log and a BillingStateError when none. */
  async #workspaceOf(customerId: string, stripeInvoiceId: string): Promise<string> {
    const workspaceId = await this.deps.customers.workspaceOfCustomer(customerId);
    if (workspaceId !== null) return workspaceId;
    this.#metrics.counter('invoice_events_total', { outcome: 'unknown_customer' }).inc();
    this.deps.logger?.error({ stripe_invoice: stripeInvoiceId }, 'invoice.unknown_customer');
    throw new BillingStateError('unknown_workspace');
  }

  /** Whether `inv` is mirrored; warns about an unknown status, counts a dropped currency. */
  #accept(inv: ParsedInvoice, source: 'event' | 'sync'): boolean {
    if (inv.status === 'other') {
      this.deps.logger?.warn(
        { stripe_status: inv.stripeStatus ?? 'none', source },
        'invoice.unknown_status',
      );
    }
    if (isSupportedCurrency(inv.currency)) return true;
    this.#metrics.counter('invoices_unsupported_currency_total', { source }).inc();
    this.deps.logger?.info({ currency: inv.currency, source }, 'invoice.unsupported_currency');
    return false;
  }

  /**
   * Stores Stripe invoice `inv` (a Stripe invoice object, checked here) by the update rule.
   * `readAt` (Unix seconds) is when this state was current: the reporting event's `created`, or
   * when it was read from Stripe. Throws a StripeError (`invalid_response`) for an object that is
   * not an invoice, and a BillingStateError (`unknown_workspace`) for an invoice of a customer no
   * workspace has.
   */
  async applyInvoiceEvent(inv: unknown, readAt?: number): Promise<void> {
    const parsed = parseStripeInvoice(inv, readAt);
    const workspaceId = await this.#workspaceOf(parsed.customerId, parsed.stripeInvoiceId);
    if (!this.#accept(parsed, 'event')) {
      this.#metrics.counter('invoice_events_total', { outcome: 'unsupported_currency' }).inc();
      return;
    }
    const written = await this.deps.repository.upsert(
      [rowOf(workspaceId, parsed)],
      new Date(this.#clock()),
    );
    this.#metrics
      .counter('invoice_events_total', { outcome: written > 0 ? 'written' : 'unchanged' })
      .inc();
  }

  /**
   * Retrieves Stripe invoice `stripeInvoiceId` and stores it as of now (B072's handler: one call
   * per `invoice.*` event). Throws what `applyInvoiceEvent` and Stripe throw; a StripeError
   * (`not_configured`) when billing is off.
   */
  async refreshInvoice(stripeInvoiceId: string): Promise<void> {
    if (this.deps.stripe === null) {
      throw new StripeError('not_configured', 'billing is off: no Stripe key');
    }
    const readAt = this.#nowS();
    await this.applyInvoiceEvent(await this.deps.stripe.retrieveInvoice(stripeInvoiceId), readAt);
  }

  /**
   * Drops the mirror's copy of Stripe invoice `inv` when it is a draft (Stripe deletes only
   * drafts: B072's `invoice.deleted`); `inv` needs only its `id` and `customer`, so B072's reduced
   * object will do. Throws a StripeError for an object that is not an invoice, and a
   * BillingStateError for a customer no workspace has.
   */
  async removeInvoice(inv: unknown): Promise<boolean> {
    const ref = invoiceRef(inv);
    const workspaceId = await this.#workspaceOf(ref.customerId, ref.stripeInvoiceId);
    return this.deps.repository.removeDraft(workspaceId, ref.stripeInvoiceId);
  }

  /**
   * Reads the workspace's newest invoices from Stripe and stores them (one Stripe call). A
   * workspace without a Stripe customer has nothing to read. Throws what Stripe or the database
   * threw; the list's lazy sync catches it.
   */
  async syncInvoices(workspaceId: string): Promise<{ upserted: number }> {
    const { stripe, repository } = this.deps;
    if (stripe === null) return { upserted: 0 };
    const customerId = await this.deps.customers.findCustomer(workspaceId);
    const started = new Date(this.#clock());
    if (customerId === null) {
      await repository.recordSynced(workspaceId, started);
      return { upserted: 0 };
    }
    const readAt = this.#nowS();
    const page = await stripe.listInvoices(customerId, { limit: SYNC_PAGE_SIZE });
    const rows: InvoiceRow[] = [];
    const seen: string[] = [];
    let oldest: Date | null = null;
    let unreadable = 0;
    for (const raw of page.data) {
      let parsed: ParsedInvoice;
      try {
        parsed = parseStripeInvoice(raw, readAt);
      } catch {
        unreadable += 1;
        continue;
      }
      // Asked by customer; anything else is not this workspace's.
      if (parsed.customerId !== customerId) continue;
      seen.push(parsed.stripeInvoiceId);
      if (oldest === null || parsed.createdAt < oldest) oldest = parsed.createdAt;
      if (this.#accept(parsed, 'sync')) rows.push(rowOf(workspaceId, parsed));
    }
    if (unreadable > 0) this.deps.logger?.warn({ count: unreadable }, 'invoice.unreadable');
    const upserted = await repository.upsert(rows, started);
    // Drafts Stripe no longer lists (deleted) within the window this page covers (strictly newer
    // than its oldest invoice, so one on the next page in the same second stays); never a row
    // written since the call began (a webhook's new draft), and not when an invoice was unreadable.
    if (unreadable === 0) {
      await repository.removeDrafts(workspaceId, seen, {
        since: page.hasMore ? oldest : null,
        writtenBefore: started,
      });
    }
    await repository.recordSynced(workspaceId, new Date(this.#clock()));
    this.#metrics.counter('invoice_syncs_total').inc();
    return { upserted };
  }

  /** Logs and counts a failed sync. */
  #failed(workspaceId: string, err: unknown): void {
    const reason = failureReason(err);
    this.#metrics.counter('invoice_sync_failed_total', { reason }).inc();
    this.deps.logger?.warn({ workspace_id: workspaceId, reason }, 'invoice.sync_failed');
  }

  /** Remembers when this process may next try a sync of `workspaceId`. */
  #remember(workspaceId: string, at: number): void {
    if (this.#nextAttempt.size >= MAX_REMEMBERED_WORKSPACES) this.#nextAttempt.clear();
    this.#nextAttempt.set(workspaceId, at);
  }

  /**
   * Claims a sync of `workspaceId` if its last attempt is older than the interval, then runs it:
   * a first sync is awaited, a refresh of a synced mirror runs in the background. Never throws.
   */
  async #refresh(workspaceId: string): Promise<void> {
    let claim: Awaited<ReturnType<InvoiceRepository['claimSync']>>;
    try {
      claim = await this.deps.repository.claimSync(
        workspaceId,
        new Date(this.#clock()),
        SYNC_INTERVAL_MS,
      );
    } catch (err) {
      this.#failed(workspaceId, err);
      return;
    }
    this.#remember(workspaceId, claim.attemptedAt.getTime() + SYNC_INTERVAL_MS);
    if (!claim.claimed) return;
    const sync = this.syncInvoices(workspaceId).then(
      () => undefined,
      (err: unknown) => this.#failed(workspaceId, err),
    );
    if (claim.syncedAt === null) {
      await sync;
      return;
    }
    this.#background.add(sync);
    void sync.finally(() => this.#background.delete(sync));
  }

  /**
   * Starts a lazy sync of `workspaceId` when its mirror is stale (one per workspace in flight).
   * Waits for the claim, and for a first sync at most `syncWaitMs`. Never throws.
   */
  async refreshIfStale(workspaceId: string): Promise<void> {
    if (this.deps.stripe === null) return;
    const next = this.#nextAttempt.get(workspaceId);
    if (next !== undefined && this.#clock() < next) return;
    let flight = this.#inflight.get(workspaceId);
    if (flight === undefined) {
      flight = this.#refresh(workspaceId).finally(() => this.#inflight.delete(workspaceId));
      this.#inflight.set(workspaceId, flight);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#waitMs);
    });
    try {
      await Promise.race([flight, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves when every sync this process started has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0 || this.#background.size > 0) {
      await Promise.all([...this.#inflight.values(), ...this.#background]);
    }
  }

  /** One page of the workspace's invoices (CT-PAGE), from the mirror after a lazy sync. */
  async list(workspaceId: string, page: PageParams): Promise<Page<Api.Invoice>> {
    await this.refreshIfStale(workspaceId);
    const result = await this.deps.repository.list(workspaceId, page);
    return { ...result, data: result.data.map(publicInvoice) };
  }
}
