-- Billing (B070, CT-API-BILLING): a workspace's Stripe customer and its subscription as Stripe last
-- reported it. Stripe holds the card, the address and the tax ids; nothing of that is stored here.
--
-- - billing_customer: one Stripe customer per workspace, written only after Stripe created it
--   (so a failed call leaves no row). The unique Stripe id stops two workspaces sharing one.
-- - billing_subscription: one row per workspace, `id` its Centcom `sub_` id (CT-IDS; the Stripe
--   subscription id is never shown). `status` is the contract's (B070 `mapStripeStatus`), `seats`
--   the total (a plan's included seats plus add-on seats), `currency` as Stripe returned it.
--   `stripe_event_created` (Unix seconds) is the stale-event guard: an update older than it is
--   ignored.
--
-- Rows go with their workspace (B027's purge). Named after main's newest migration
-- (20260102002900, B087) instead of the card's 0070_*, skipping 20260102003000 and
-- 20260102003100, which the open PRs of B081 and B031 use.

create table billing_customer (
  workspace_id text primary key references workspaces (id) on delete cascade,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  created_at timestamptz not null default now()
);

create table billing_subscription (
  workspace_id text primary key references workspaces (id) on delete cascade,
  id text not null unique check (id ~ '^sub_[0-9A-HJKMNP-TV-Z]{26}$'),
  stripe_subscription_id text not null unique
    check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  plan text not null check (plan in ('pro', 'team')),
  status text not null check (status in ('active', 'trialing', 'past_due', 'canceled', 'none')),
  interval text not null check (interval in ('month', 'year')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  period_start timestamptz,
  period_end timestamptz,
  seats integer not null check (seats between 0 and 100000),
  cancel_at_period_end boolean not null default false,
  past_due_since timestamptz,
  updated_at timestamptz not null default now(),
  stripe_event_created bigint not null check (stripe_event_created >= 0),
  check (period_start is null or period_end is null or period_start <= period_end)
);

-- rollback note: drop table billing_subscription; drop table billing_customer; the Stripe customers
-- and subscriptions stay in Stripe and are found again by their workspace_id metadata.
