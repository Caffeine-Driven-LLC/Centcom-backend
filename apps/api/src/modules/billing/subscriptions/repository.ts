/**
 * The SQL of billing (B070): a workspace's Stripe customer and subscription.
 *
 * - `linkCustomer` inserts the link unless the workspace has one already, and answers whichever
 *   is stored: of concurrent links, the first wins and every caller gets its id.
 * - `upsertSubscription` writes the workspace's row unless the stored one came from a newer Stripe
 *   event (`stripe_event_created`): an older update changes nothing (the stale-event guard), an
 *   equal one is applied again (a replay writes the same state).
 * - `billingContact` is whom Stripe e-mails: the workspace's earliest `billing` member, else its
 *   owner, active users only.
 *
 * Owns: the statements. Must not: store card data, e-mail addresses or Stripe payloads.
 */
import type { BillingDb } from '@centcom/db';
import { sql, type Kysely } from 'kysely';

/** A stored subscription. */
export interface SubscriptionRow {
  workspaceId: string;
  /** Centcom `sub_` id. */
  id: string;
  stripeSubscriptionId: string;
  plan: 'pro' | 'team';
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  interval: 'month' | 'year';
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  seats: number;
  cancelAtPeriodEnd: boolean;
  pastDueSince: Date | null;
  updatedAt: Date;
  /** Unix seconds. */
  stripeEventCreated: number;
}

/** Whom Stripe e-mails about a workspace's billing. */
export interface BillingContact {
  email: string;
  locale: string;
  name: string;
}

/** Billing persistence. */
export interface BillingRepository {
  /** The workspace's Stripe customer id, or null. */
  findCustomer(workspaceId: string): Promise<string | null>;
  /** Links `customerId` unless the workspace has a customer; returns the stored id. */
  linkCustomer(workspaceId: string, customerId: string): Promise<string>;
  /** The workspace whose customer `customerId` is, or null. */
  workspaceOfCustomer(customerId: string): Promise<string | null>;
  /** The billing contact of a live workspace, or null (no live workspace or contact). */
  billingContact(workspaceId: string): Promise<BillingContact | null>;
  /** The workspace's subscription, or null. */
  findSubscription(workspaceId: string): Promise<SubscriptionRow | null>;
  /**
   * Writes `row` unless the stored row came from a newer event; returns the stored row and
   * whether this write was applied.
   */
  upsertSubscription(row: SubscriptionRow): Promise<{ row: SubscriptionRow; applied: boolean }>;
}

type Selected = {
  workspace_id: string;
  id: string;
  stripe_subscription_id: string;
  plan: 'pro' | 'team';
  status: SubscriptionRow['status'];
  interval: 'month' | 'year';
  currency: string;
  period_start: Date | null;
  period_end: Date | null;
  seats: number;
  cancel_at_period_end: boolean;
  past_due_since: Date | null;
  updated_at: Date;
  stripe_event_created: string;
};

const SUBSCRIPTION_COLUMNS = [
  'workspace_id',
  'id',
  'stripe_subscription_id',
  'plan',
  'status',
  'interval',
  'currency',
  'period_start',
  'period_end',
  'seats',
  'cancel_at_period_end',
  'past_due_since',
  'updated_at',
  'stripe_event_created',
] as const;

const rowOf = (r: Selected): SubscriptionRow => ({
  workspaceId: r.workspace_id,
  id: r.id,
  stripeSubscriptionId: r.stripe_subscription_id,
  plan: r.plan,
  status: r.status,
  interval: r.interval,
  currency: r.currency,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  seats: r.seats,
  cancelAtPeriodEnd: r.cancel_at_period_end,
  pastDueSince: r.past_due_since,
  updatedAt: r.updated_at,
  stripeEventCreated: Number(r.stripe_event_created),
});

/** The repository on Postgres (migration 20260102002000). */
export function createBillingRepository<DB extends BillingDb>(
  database: Kysely<DB>,
): BillingRepository {
  // Kysely's types are invariant in the database type; only these tables are touched.
  const db = database as unknown as Kysely<BillingDb>;

  const findSubscription = async (workspaceId: string): Promise<SubscriptionRow | null> => {
    const row = await db
      .selectFrom('billing_subscription')
      .select(SUBSCRIPTION_COLUMNS)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return row === undefined ? null : rowOf(row);
  };

  return {
    async findCustomer(workspaceId) {
      const row = await db
        .selectFrom('billing_customer')
        .select('stripe_customer_id')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
      return row?.stripe_customer_id ?? null;
    },

    async linkCustomer(workspaceId, customerId) {
      await db
        .insertInto('billing_customer')
        .values({ workspace_id: workspaceId, stripe_customer_id: customerId })
        .onConflict((oc) => oc.column('workspace_id').doNothing())
        .execute();
      const row = await db
        .selectFrom('billing_customer')
        .select('stripe_customer_id')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      return row.stripe_customer_id;
    },

    async workspaceOfCustomer(customerId) {
      const row = await db
        .selectFrom('billing_customer')
        .select('workspace_id')
        .where('stripe_customer_id', '=', customerId)
        .executeTakeFirst();
      return row?.workspace_id ?? null;
    },

    async billingContact(workspaceId) {
      const row = await db
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .innerJoin('workspaces', 'workspaces.id', 'memberships.workspace_id')
        .select(['users.email', 'users.locale', 'workspaces.name'])
        .where('memberships.workspace_id', '=', workspaceId)
        .where('memberships.role', 'in', ['billing', 'owner'])
        .where('users.status', '=', 'active')
        .where('workspaces.deleted_at', 'is', null)
        .orderBy(sql`case when memberships.role = 'billing' then 0 else 1 end`)
        .orderBy('memberships.created_at')
        .orderBy('memberships.id')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : { email: row.email, locale: row.locale, name: row.name };
    },

    findSubscription,

    async upsertSubscription(row) {
      const values = {
        workspace_id: row.workspaceId,
        id: row.id,
        stripe_subscription_id: row.stripeSubscriptionId,
        plan: row.plan,
        status: row.status,
        interval: row.interval,
        currency: row.currency,
        period_start: row.periodStart,
        period_end: row.periodEnd,
        seats: row.seats,
        cancel_at_period_end: row.cancelAtPeriodEnd,
        past_due_since: row.pastDueSince,
        updated_at: row.updatedAt,
        stripe_event_created: row.stripeEventCreated,
      };
      const written = await db
        .insertInto('billing_subscription')
        .values(values)
        .onConflict((oc) =>
          oc
            .column('workspace_id')
            .doUpdateSet({
              stripe_subscription_id: (eb) => eb.ref('excluded.stripe_subscription_id'),
              plan: (eb) => eb.ref('excluded.plan'),
              status: (eb) => eb.ref('excluded.status'),
              interval: (eb) => eb.ref('excluded.interval'),
              currency: (eb) => eb.ref('excluded.currency'),
              period_start: (eb) => eb.ref('excluded.period_start'),
              period_end: (eb) => eb.ref('excluded.period_end'),
              seats: (eb) => eb.ref('excluded.seats'),
              cancel_at_period_end: (eb) => eb.ref('excluded.cancel_at_period_end'),
              past_due_since: (eb) => eb.ref('excluded.past_due_since'),
              updated_at: (eb) => eb.ref('excluded.updated_at'),
              stripe_event_created: (eb) => eb.ref('excluded.stripe_event_created'),
            })
            .where(
              sql<boolean>`billing_subscription.stripe_event_created <= excluded.stripe_event_created`,
            ),
        )
        .returning(SUBSCRIPTION_COLUMNS)
        .executeTakeFirst();
      if (written !== undefined) return { row: rowOf(written), applied: true };
      const stored = await findSubscription(row.workspaceId);
      if (stored === null)
        throw new Error('billing_subscription: the row vanished during the upsert');
      return { row: stored, applied: false };
    },
  };
}
