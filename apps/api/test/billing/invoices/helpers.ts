/**
 * Fixtures for the invoice mirror tests (B077):
 *
 * - Stripe invoice objects in `fixtures/*.json`, shaped like Stripe test-mode invoices of API
 *   2025-03-31.basil (and one of an older version, with `tax`, `charge` and `payment_intent`); the
 *   ids and links are stand-ins. `invoiceOf` hands out a copy for a customer, with a fresh id.
 * - `FakeInvoiceStripe`: lists a customer's invoices newest first, records calls, and can be
 *   scripted to fail or to stall until released.
 * - `memoryInvoices`: an in-memory InvoiceRepository by the Postgres one's rules.
 * - `invoicesApp`: the invoice route on the workspace routes' plugin stack (B021 RBAC over the
 *   store's memberships), over an InvoiceService with B070's in-memory customer links.
 *
 * Secret-looking values (Stripe ids) are built at run time.
 */
import { readFileSync } from 'node:fs';
import { paginateArray, type ArrayKeysetSpec } from '@centcom/core';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import type {
  InvoiceStripe,
  StripeInvoicePage,
} from '../../../src/modules/billing/invoices/ports.js';
import type {
  InvoiceRepository,
  InvoiceRow,
} from '../../../src/modules/billing/invoices/repository.js';
import { InvoiceService } from '../../../src/modules/billing/invoices/service.js';
import { shouldReplace } from '../../../src/modules/billing/invoices/stripe-invoice.js';
import { invoiceRoutes } from '../../../src/routes/billing-invoices.js';
import { asUser, createWorkspace, KEYS, workspacesApp } from '../../modules/workspaces/helpers.js';
import { memoryBilling, newId, stripeId } from '../subscriptions/helpers.js';

export { newId, stripeId };

/** The fixture files. */
export const FIXTURES = [
  'paid-usd-tax',
  'open-eur-vat',
  'draft-eur',
  'void-usd',
  'uncollectible-usd',
  'zero-total-usd',
  'open-gbp',
  'legacy-paid-usd',
] as const;

/** A fixture's name. */
export type FixtureName = (typeof FIXTURES)[number];

/** Fixture `name`, as Stripe sent it. */
export function fixture(name: FixtureName): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

/** Fixture `name` as an invoice of `customerId`, with a fresh id and `overrides`. */
export function invoiceOf(
  name: FixtureName,
  customerId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...fixture(name), id: stripeId('in'), customer: customerId, ...overrides };
}

/** Unix seconds of a UTC date. */
export const unix = (year: number, month: number, day: number, hour = 0): number =>
  Date.UTC(year, month - 1, day, hour) / 1000;

/** A copy of an invoice of `customerId` created at `created` (Unix seconds), paid then. */
export function paidAt(customerId: string, created: number): Record<string, unknown> {
  return invoiceOf('paid-usd-tax', customerId, {
    created,
    status_transitions: { finalized_at: created, paid_at: created },
  });
}

const createdOf = (invoice: Record<string, unknown>): number => Number(invoice['created']);

/** A fake Stripe with invoices by customer. */
export class FakeInvoiceStripe implements InvoiceStripe {
  readonly invoices = new Map<string, Record<string, unknown>[]>();
  readonly listCalls: { customerId: string; limit: number }[] = [];
  /** Errors the next calls throw, in order. */
  readonly failures: Error[] = [];
  /** While set, calls wait for it. */
  gate: Promise<void> | null = null;

  /** Adds invoices to `customerId`'s. */
  add(customerId: string, ...invoices: Record<string, unknown>[]): void {
    this.invoices.set(customerId, [...(this.invoices.get(customerId) ?? []), ...invoices]);
  }

  /** Makes calls wait until the returned function is called. */
  stall(): () => void {
    let release = (): void => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = () => {
        this.gate = null;
        resolve();
      };
    });
    return release;
  }

  async listInvoices(
    customerId: string,
    page: { limit: number; startingAfter?: string },
  ): Promise<StripeInvoicePage> {
    this.listCalls.push({ customerId, limit: page.limit });
    if (this.gate !== null) await this.gate;
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    const all = [...(this.invoices.get(customerId) ?? [])].sort(
      (a, b) => createdOf(b) - createdOf(a),
    );
    return {
      data: all.slice(0, page.limit).map((invoice) => structuredClone(invoice)),
      hasMore: all.length > page.limit,
    };
  }

  async retrieveInvoice(id: string): Promise<unknown> {
    if (this.gate !== null) await this.gate;
    for (const list of this.invoices.values()) {
      const found = list.find((invoice) => invoice['id'] === id);
      if (found !== undefined) return structuredClone(found);
    }
    throw new StripeError('request', 'no such invoice', 404);
  }
}

/** A stored row as the memory repository keeps it. */
export type MemoryRow = InvoiceRow & { updatedAt: Date };

const SPEC: ArrayKeysetSpec<MemoryRow> = {
  sorts: { created: { value: (row) => row.createdAt.toISOString(), direction: 'desc' } },
  id: (row) => row.id,
};

/** The in-memory repository, by the Postgres one's rules. */
export function memoryInvoices() {
  const rows = new Map<string, MemoryRow>();
  const syncs = new Map<string, { attemptedAt: Date; syncedAt: Date | null }>();
  const repository: InvoiceRepository = {
    upsert(list, at) {
      let written = 0;
      for (const row of list) {
        const stored = rows.get(row.stripeInvoiceId);
        if (stored === undefined) {
          rows.set(row.stripeInvoiceId, { ...row, updatedAt: at });
          written += 1;
        } else if (stored.workspaceId === row.workspaceId && shouldReplace(stored, row)) {
          rows.set(row.stripeInvoiceId, {
            ...row,
            id: stored.id,
            version: Math.max(stored.version, row.version),
            updatedAt: at,
          });
          written += 1;
        }
      }
      return Promise.resolve(written);
    },
    list(workspaceId, page) {
      const listed = [...rows.values()].filter(
        (row) => row.workspaceId === workspaceId && row.status !== 'other',
      );
      return Promise.resolve(paginateArray(listed, SPEC, page));
    },
    find(workspaceId, stripeInvoiceId) {
      const row = rows.get(stripeInvoiceId);
      return Promise.resolve(row?.workspaceId === workspaceId ? { ...row } : null);
    },
    removeDrafts(workspaceId, keep, window) {
      let removed = 0;
      for (const [id, row] of rows) {
        if (
          row.workspaceId === workspaceId &&
          row.status === 'draft' &&
          !keep.includes(id) &&
          row.updatedAt < window.writtenBefore &&
          (window.since === null || row.createdAt > window.since)
        ) {
          rows.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
    removeDraft(workspaceId, stripeInvoiceId) {
      const row = rows.get(stripeInvoiceId);
      if (row?.status !== 'draft' || row.workspaceId !== workspaceId) {
        return Promise.resolve(false);
      }
      rows.delete(stripeInvoiceId);
      return Promise.resolve(true);
    },
    claimSync(workspaceId, now, intervalMs) {
      const sync = syncs.get(workspaceId);
      if (sync === undefined || sync.attemptedAt.getTime() <= now.getTime() - intervalMs) {
        const syncedAt = sync?.syncedAt ?? null;
        syncs.set(workspaceId, { attemptedAt: now, syncedAt });
        return Promise.resolve({ claimed: true, attemptedAt: now, syncedAt });
      }
      return Promise.resolve({
        claimed: false,
        attemptedAt: sync.attemptedAt,
        syncedAt: sync.syncedAt,
      });
    },
    recordSynced(workspaceId, at) {
      const sync = syncs.get(workspaceId);
      if (sync !== undefined) sync.syncedAt = at;
      return Promise.resolve();
    },
  };
  return { repository, rows, syncs };
}

/** Options of the test app. */
export interface InvoicesAppOptions {
  /** Milliseconds; default a fixed time that tests move. */
  clock?: () => number;
  syncWaitMs?: number;
  rateLimit?: boolean;
  /** Billing off: the service gets no Stripe. */
  billingOff?: boolean;
  mirror?: ReturnType<typeof memoryInvoices>;
}

/** The invoice route on the workspace routes' stack, over an in-memory mirror and a fake Stripe. */
export async function invoicesApp(options: InvoicesAppOptions = {}) {
  const billing = memoryBilling();
  const mirror = options.mirror ?? memoryInvoices();
  const stripe = new FakeInvoiceStripe();
  const clock = options.clock ?? Date.now;
  let service: InvoiceService | undefined;
  const wapp = await workspacesApp({
    clock,
    ...(options.rateLimit === true ? { rateLimit: true } : {}),
    beforeReady: async (app, ctx) => {
      service = new InvoiceService({
        repository: mirror.repository,
        stripe: options.billingOff === true ? null : stripe,
        customers: billing.repository,
        clock,
        ...(options.syncWaitMs === undefined ? {} : { syncWaitMs: options.syncWaitMs }),
        logger: ctx.captured.logger,
        metrics: ctx.recorded.metrics,
      });
      await app.register(invoiceRoutes, { invoices: service, cursorKeys: KEYS, clock });
    },
  });
  if (service === undefined) throw new Error('invoicesApp: no service');
  return { ...wapp, billing, mirror, stripe, service };
}

/** An app with a workspace, its owner and its Stripe customer. */
export async function withWorkspace(options: InvoicesAppOptions = {}) {
  const ctx = await invoicesApp(options);
  const owner = newId('usr');
  ctx.store.addUser(owner);
  const ws = (await createWorkspace(ctx.app, owner)).id;
  const customer = stripeId('cus');
  ctx.billing.customers.set(ws, customer);
  return { ...ctx, owner, ws, customer };
}

/** The scope the invoice list needs. */
export const READ = 'billing:read';

/** `GET /v1/workspaces/{ws}/invoices` as `userId` with `query`. */
export function listAs(
  ctx: { app: Awaited<ReturnType<typeof invoicesApp>>['app'] },
  ws: string,
  userId: string,
  query = '',
) {
  return ctx.app.inject({
    method: 'GET',
    url: `/v1/workspaces/${ws}/invoices${query === '' ? '' : `?${query}`}`,
    headers: asUser(userId, READ),
  });
}
