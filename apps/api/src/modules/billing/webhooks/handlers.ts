/**
 * What each Stripe event does (B072). Handlers are idempotent: replaying any event any number of
 * times ends in the same state.
 *
 * - **Never trust the payload's order** (guardrail): every subscription-related event re-fetches
 *   the subscription from Stripe and stores it through B070's `upsertFromStripe`, whose stale
 *   guard (the event's `created`) keeps a late, older event from undoing a newer one, and which
 *   hands applied states to B069's `applySubscriptionState` (the only way entitlements change).
 * - `customer.subscription.created|updated|deleted`: reconcile the subscription.
 * - `checkout.session.completed`: reconcile its subscription (a session without one is ignored).
 * - `invoice.paid`: reconcile; outbox `billing.invoice.paid`.
 * - `invoice.payment_failed`: reconcile (Stripe moves the subscription to `past_due`; B070 records
 *   `past_due_since` once and keeps it on later failures); outbox
 *   `billing.invoice.payment_failed` and one `notify.billing_issue` per invoice.
 * - A reconcile that B070 applied writes `billing.subscription.updated` (once per event).
 * - Anything else is ignored.
 *
 * `reduceObject` is what ingestion keeps of an event's object: ids, status, amounts and currency.
 * Never card data, addresses, names or e-mail addresses.
 *
 * Owns: the per-type rules. Must not: change entitlements other than through B070/B069, or keep
 * more of a payload than `reduceObject` does.
 */
import type { StripeGateway } from '../stripe/gateway.js';
import type { BillingService } from '../subscriptions/service.js';
import { BillingStateError } from '../subscriptions/service.js';
import type { OutboxStore } from './outbox.js';

/** The event types with a handler; others are stored as `ignored`. */
export const HANDLED_TYPES: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** The fields of an object ingestion keeps, and what each must look like. */
const KEPT: Readonly<Record<string, RegExp | 'amount'>> = {
  object: /^[a-z_.]{1,40}$/,
  id: /^[a-z]{2,8}_[A-Za-z0-9]{1,250}$/,
  customer: /^cus_[A-Za-z0-9]{1,250}$/,
  subscription: /^sub_[A-Za-z0-9]{1,250}$/,
  status: /^[a-z_]{1,40}$/,
  currency: /^[a-z]{3}$/,
  amount_paid: 'amount',
  amount_due: 'amount',
};

/** What ingestion keeps of an event's `data.object` (see the module comment). */
export function reduceObject(object: unknown): Record<string, string | number> {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) return {};
  const source = object as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const [field, rule] of Object.entries(KEPT)) {
    let value = source[field];
    // Stripe may expand references into objects; keep only their ids.
    if (typeof value === 'object' && value !== null && 'id' in value) {
      value = (value as { id: unknown }).id;
    }
    if (rule === 'amount') {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
        out[field] = value;
    } else if (typeof value === 'string' && rule.test(value)) {
      out[field] = value;
    }
  }
  return out;
}

/** What handlers need. */
export interface HandlerDeps {
  gateway: Pick<StripeGateway, 'retrieveSubscription'>;
  billing: Pick<BillingService, 'upsertFromStripe'>;
  outbox: Pick<OutboxStore, 'add'>;
  /** The workspace of a Stripe customer (B070's link), or null. */
  workspaceOfCustomer(customerId: string): Promise<string | null>;
}

/** An event as a handler reads it. */
export interface HandledEvent {
  eventId: string;
  type: string;
  created: number;
  object: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Re-fetches subscription `subId`, stores it, and announces an applied change; the workspace. */
async function reconcile(event: HandledEvent, subId: string, deps: HandlerDeps): Promise<string> {
  const sub = await deps.gateway.retrieveSubscription(subId);
  const result = await deps.billing.upsertFromStripe(sub, event.created);
  const workspaceId =
    result.view?.workspace ?? (await deps.workspaceOfCustomer(sub.customerId)) ?? sub.workspaceId;
  if (workspaceId === null) throw new BillingStateError('unknown_workspace');
  if (result.applied && result.view !== null) {
    await deps.outbox.add({
      type: 'billing.subscription.updated',
      workspaceId,
      payload: { plan: result.view.plan, status: result.view.status, seats: result.view.seats },
      dedupeKey: event.eventId,
    });
  }
  return workspaceId;
}

/** The workspace of an invoice: its subscription's (reconciled), else its customer's. */
async function invoiceWorkspace(event: HandledEvent, deps: HandlerDeps): Promise<string> {
  const subId = str(event.object['subscription']);
  if (subId !== null) return reconcile(event, subId, deps);
  const customer = str(event.object['customer']);
  const workspaceId = customer === null ? null : await deps.workspaceOfCustomer(customer);
  if (workspaceId === null) throw new BillingStateError('unknown_workspace');
  return workspaceId;
}

/** An invoice's webhook data: its id, amount and currency. */
function invoiceData(event: HandledEvent, amountField: 'amount_paid' | 'amount_due') {
  const amount = event.object[amountField];
  const currency = str(event.object['currency']);
  return {
    invoice: str(event.object['id']) ?? event.eventId,
    amount: typeof amount === 'number' ? amount : 0,
    currency: (currency ?? 'usd').toUpperCase(),
  };
}

/** Handles `event`; `ignored` when its type has no handler or nothing applies. */
export async function handleEvent(
  event: HandledEvent,
  deps: HandlerDeps,
): Promise<'processed' | 'ignored'> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subId = str(event.object['id']);
      if (subId === null || !subId.startsWith('sub_')) return 'ignored';
      await reconcile(event, subId, deps);
      return 'processed';
    }
    case 'checkout.session.completed': {
      const subId = str(event.object['subscription']);
      if (subId === null) return 'ignored';
      await reconcile(event, subId, deps);
      return 'processed';
    }
    case 'invoice.paid': {
      const workspaceId = await invoiceWorkspace(event, deps);
      const data = invoiceData(event, 'amount_paid');
      await deps.outbox.add({
        type: 'billing.invoice.paid',
        workspaceId,
        payload: data,
        dedupeKey: data.invoice,
      });
      return 'processed';
    }
    case 'invoice.payment_failed': {
      const workspaceId = await invoiceWorkspace(event, deps);
      const data = invoiceData(event, 'amount_due');
      await deps.outbox.add({
        type: 'billing.invoice.payment_failed',
        workspaceId,
        payload: data,
        dedupeKey: data.invoice,
      });
      await deps.outbox.add({
        type: 'notify.billing_issue',
        workspaceId,
        payload: { kind: 'payment_failed' },
        dedupeKey: data.invoice,
      });
      return 'processed';
    }
    default:
      return 'ignored';
  }
}
