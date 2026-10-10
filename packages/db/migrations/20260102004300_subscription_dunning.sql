-- Dunning (B078, CT-ENTITLEMENTS §4 "past_due: grace 7 days, then none"; "canceled: until
-- period.end, then none"): the payment-failure lifecycle of each workspace's subscription.
--
-- - subscription_dunning: one row per workspace that had a billing event since B078. `state` is
--   the status dunning last moved the workspace to; `first_failed_at` and `grace_until` (always
--   7 days later) describe the open payment failure; `period_end` is a canceled subscription's
--   end; `reminders_sent` is a bitmask of the grace-day reminders sent (1 day 0, 2 day 3, 4 day
--   6); `none_at` and `none_reason` say when and why the workspace dropped to `none`, and
--   `announced_at` when that drop was announced (rev, plan_changed notice, webhook, wind-down
--   job), so a drop that crashed before its announcement is announced by the next run.
--
-- Billing rows go with their workspace (on delete cascade), as B070's billing_subscription does:
-- they are neither history nor audit data.
--
-- Named after the newest version on main and in open PRs (B090's 20260102004200, #96), instead
-- of the card's 078_subscription_dunning.sql, which the runner refuses.

create table subscription_dunning (
  workspace_id text primary key references workspaces (id) on delete cascade,
  state text not null check (state in ('active', 'trialing', 'past_due', 'canceled', 'none')),
  failed_invoice text check (failed_invoice ~ '^in_[A-Za-z0-9]{1,250}$'),
  first_failed_at timestamptz,
  grace_until timestamptz,
  period_end timestamptz,
  reminders_sent smallint not null default 0 check (reminders_sent between 0 and 7),
  none_at timestamptz,
  none_reason text check (none_reason in ('grace_expired', 'period_ended', 'subscription_ended')),
  announced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'past_due') = (first_failed_at is not null and grace_until is not null)),
  -- Exactly 168 hours (not '7 days', which follows the session time zone's daylight saving).
  check (grace_until is null or grace_until = first_failed_at + interval '168 hours'),
  check ((state = 'none') = (none_at is not null and none_reason is not null))
);

-- The expiry job's scans: open failures by grace end, cancellations by period end, and drops
-- not announced yet, oldest first.
create index subscription_dunning_grace_until_idx on subscription_dunning (grace_until)
  where state = 'past_due';
create index subscription_dunning_period_end_idx on subscription_dunning (period_end)
  where state = 'canceled';
create index subscription_dunning_none_at_idx on subscription_dunning (none_at)
  where state = 'none' and announced_at is null;

-- rollback note: drop table subscription_dunning (entitlements keep resolving from
-- billing_subscription; a past_due workspace still drops to none on read after its grace).
