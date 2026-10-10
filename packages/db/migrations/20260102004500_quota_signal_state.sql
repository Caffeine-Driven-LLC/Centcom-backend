-- Quota signals (B076, CT-ENTITLEMENTS §5): which 80 % ("warn") and 100 % ("reached") signals each
-- workspace, metered limit and period has had, and how far each signal's delivery has got.
--
-- - One row per (workspace, limit, period_start, level): the row is written in the same
--   transaction as the decision to signal, so a level fires at most once per period. Deleting the
--   row re-arms the level; that happens only when the limit is removed or raised above
--   limit_value (the limit the level was claimed under) so usage is below it. A new period has no
--   rows.
-- - Delivery is three steps, each marked (committed on its own) right after it succeeded: the
--   relay's `sys.notice` (fired_at), the owners' notification (notified_at) and the
--   `usage.threshold` webhook event (webhook_at). A step that failed is retried; the others are not
--   repeated.
-- - period_end is the period's end (the notices' `resets_at`); claimed_at tells a level claimed
--   again after a re-arm from the first claim (the notification's dedupe key carries it).
--
-- Rows go with their workspace. Named after main's newest migration (20260102003800, B079) instead
-- of the card's 076_quota_signal_state.sql, which the runner refuses.

-- The foreign key and the index on usage_counter briefly lock workspaces and usage_counter.
set local lock_timeout = '5s';

create table quota_signal_state (
  workspace_id text not null references workspaces (id) on delete cascade,
  limit_key text not null check (limit_key in ('hosted_minutes_month', 'queue_items_month')),
  period_start timestamptz not null,
  level text not null check (level in ('warn', 'reached')),
  period_end timestamptz not null check (period_end > period_start),
  limit_value bigint not null check (limit_value >= 0),
  claimed_at timestamptz not null default now(),
  fired_at timestamptz,
  notified_at timestamptz,
  webhook_at timestamptz,
  primary key (workspace_id, limit_key, period_start, level)
);

-- Signals with a delivery step still to do (the sweep retries them).
create index quota_signal_state_undelivered_idx on quota_signal_state (workspace_id)
  where fired_at is null or notified_at is null or webhook_at is null;

-- Periods that ended recently (the sweep moves their workspaces' state to the new period).
create index quota_signal_state_period_end_idx on quota_signal_state (period_end);

-- The sweep's other source: workspaces whose quota meters (B075's usage_counter) moved recently.
create index usage_counter_quota_meters_updated_idx on usage_counter (updated_at)
  where metric in ('relay.hosted_minutes', 'relay.queue_items');

-- rollback note: drop index usage_counter_quota_meters_updated_idx; drop table quota_signal_state;
-- signals then fire again for crossings already announced this period.
