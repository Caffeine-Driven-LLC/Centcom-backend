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
 * - `customer.subscription.trial_will_end` (B079): reconcile; outbox `billing.subscription.updated`
 *   (once per event, applied or not) and one `notify.trial_ending` (CT-NOTIF `trial_ending
 *   {days}`, per subscription and trial end); B079's `trialWillEnd` emails the billing contact.
 * - A reconciled subscription that Stripe reports `trialing` is handed to B079's `recordTrial`
 *   (trials are recorded only once Stripe confirms them).
 * - `invoice.payment_failed`, `invoice.paid`, `customer.subscription.updated` and
 *   `customer.subscription.deleted` are then handed to B078's dunning (`applyBillingEvent`), with
 *   the event's time, the invoice's id and the payload's status, after the reconcile.
 * - Anything else is ignored.
 *
 * `reduceObject` is what ingestion keeps of an event's object: ids, status, amounts and currency.
 * Never card data, addresses, names or e-mail addresses.
 *
 * Owns: the per-type rules. Must not: change entitlements other than through B070/B069, or keep
 * more of a payload than `reduceObject` does.
 */
import type { DunningService } from '../dunning/service.js';
import type { StripeGateway, StripeSub } from '../stripe/gateway.js';
import type { BillingService } from '../subscriptions/service.js';
import { BillingStateError } from '../subscriptions/service.js';
import type { OutboxStore } from './outbox.js';

/** The event types with a handler; others are stored as `ignored`. */
export const HANDLED_TYPES: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
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

/** B079's trials, told about the subscriptions the handlers reconcile. */
export interface TrialHooks {
  /** Keeps a trial Stripe confirmed (the subscription is `trialing`). */
  recordTrial(workspaceId: string, sub: StripeSub): Promise<unknown>;
  /** Stripe's `trial_will_end`: the trial-ending email. */
  trialWillEnd(workspaceId: string, sub: StripeSub): Promise<unknown>;
}

/** What handlers need. */
export interface HandlerDeps {
  gateway: Pick<StripeGateway, 'retrieveSubscription'>;
  billing: Pick<BillingService, 'upsertFromStripe'>;
  outbox: Pick<OutboxStore, 'add'>;
  /** The workspace of a Stripe customer (B070's link), or null. */
  workspaceOfCustomer(customerId: string): Promise<string | null>;
  /** B079's trials; without them no trial is recorded and no trial-ending email is sent. */
  trials?: TrialHooks;
  /** B078's dunning; without it no grace window, reminder or drop to `none` is driven. */
  dunning?: Pick<DunningService, 'applyBillingEvent'>;
  /** Milliseconds; default Date.now (the time dunning applies an event at). */
  clock?: () => number;
}

/** An event as a handler reads it. */
export interface HandledEvent {
  eventId: string;
  type: string;
  created: number;
  object: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A reconciled subscription: its workspace, Stripe's view and the stored one (null: none). */
interface Reconciled {
  workspaceId: string;
  sub: StripeSub;
  view: { plan: string; status: string; seats: number } | null;
}

/**
 * Re-fetches subscription `subId`, stores it, announces an applied change, and hands a trialing
 * subscription to B079.
 */
async function reconcile(
  event: HandledEvent,
  subId: string,
  deps: HandlerDeps,
): Promise<Reconciled> {
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
  if (sub.status === 'trialing') await deps.trials?.recordTrial(workspaceId, sub);
  return { workspaceId, sub, view: result.view };
}

/** The workspace of an invoice: its subscription's (reconciled), else its customer's. */
async function invoiceWorkspace(event: HandledEvent, deps: HandlerDeps): Promise<string> {
  const subId = str(event.object['subscription']);
  if (subId !== null) return (await reconcile(event, subId, deps)).workspaceId;
  const customer = str(event.object['customer']);
  const workspaceId = customer === null ? null : await deps.workspaceOfCustomer(customer);
  if (workspaceId === null) throw new BillingStateError('unknown_workspace');
  return workspaceId;
}

/** Hands `event` to B078's dunning, for `workspaceId` (the reconciled subscription's). */
async function dun(event: HandledEvent, workspaceId: string, deps: HandlerDeps): Promise<void> {
  if (deps.dunning === undefined) return;
  const invoice = event.type.startsWith('invoice.');
  await deps.dunning.applyBillingEvent(
    {
      id: event.eventId,
      type: event.type,
      created: new Date(event.created * 1000),
      workspaceId,
      invoiceId: invoice ? str(event.object['id']) : null,
      // The subscription's status when Stripe created the event (B072 keeps it, reduceObject).
      objectStatus: invoice ? null : str(event.object['status']),
    },
    new Date((deps.clock ?? Date.now)()),
  );
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
      const { workspaceId } = await reconcile(event, subId, deps);
      if (event.type !== 'customer.subscription.created') await dun(event, workspaceId, deps);
      return 'processed';
    }
    case 'customer.subscription.trial_will_end': {
      const subId = str(event.object['id']);
      if (subId === null || !subId.startsWith('sub_')) return 'ignored';
      const { workspaceId, sub, view } = await reconcile(event, subId, deps);
      if (view !== null) {
        // Announced even when the store had a newer event (one row per event either way).
        await deps.outbox.add({
          type: 'billing.subscription.updated',
          workspaceId,
          payload: { plan: view.plan, status: view.status, seats: view.seats },
          dedupeKey: event.eventId,
        });
      }
      if (sub.status === 'trialing' && sub.trialEnd !== null) {
        await deps.outbox.add({
          type: 'notify.trial_ending',
          workspaceId,
          payload: { days: Math.max(0, Math.ceil((sub.trialEnd - event.created) / 86_400)) },
          dedupeKey: `${sub.id}-${sub.trialEnd}`,
        });
      }
      await deps.trials?.trialWillEnd(workspaceId, sub);
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
      await dun(event, workspaceId, deps);
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
      await dun(event, workspaceId, deps);
      return 'processed';
    }
    default:
      return 'ignored';
  }
}
