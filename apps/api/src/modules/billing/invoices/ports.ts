/**
 * What the invoice mirror (B077) needs from elsewhere, as interfaces, so it runs against fakes in
 * tests:
 *
 * - `InvoiceStripe`: listing a customer's invoices and retrieving one. B070's `StripeClient`
 *   implements both (`listInvoices`, `retrieveInvoice`); the objects come back as Stripe sent
 *   them and are checked by `parseStripeInvoice` before anything is kept.
 * - `CustomerLinks`: B070's link between a workspace and its Stripe customer (the billing
 *   repository's `findCustomer` and `workspaceOfCustomer`).
 *
 * Owns: the interfaces. Must not: carry card data or a full payload beyond the parser.
 */
import type { BillingRepository } from '../subscriptions/repository.js';

/** A page of a customer's invoices, newest first, as Stripe sent them. */
export interface StripeInvoicePage {
  data: unknown[];
  /** Whether Stripe has older invoices after this page. */
  hasMore: boolean;
}

/** The Stripe calls of the invoice mirror. */
export interface InvoiceStripe {
  /** The customer's newest `limit` (1 to 100) invoices, after `startingAfter` (`in_…`) if given. */
  listInvoices(
    customerId: string,
    page: { limit: number; startingAfter?: string },
  ): Promise<StripeInvoicePage>;
  /** One invoice (`in_…`), as Stripe sent it. */
  retrieveInvoice(id: string): Promise<unknown>;
}

/** B070's workspace-to-customer link. */
export type CustomerLinks = Pick<BillingRepository, 'findCustomer' | 'workspaceOfCustomer'>;
