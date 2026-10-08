-- Usage aggregation and quota state (B075, CT-ENTITLEMENTS §5): counters per workspace, period
-- and metric, folded from usage_event (B074) and the relay's counters; which 80 % and 100 %
-- crossings each period has had; and how far the aggregator has read.
--
-- - usage_counter: derived, rebuildable from usage_event (raw rows are never changed). Client
--   metrics keep their type names (`agent_minutes`, `tokens_in`, `tokens_out`, `queue_items`,
--   `relay_bytes`; informational, never compared with a limit); the relay's server-side meters
--   are `relay.hosted_minutes`, `relay.queue_items` and `relay.relay_bytes` (the quota meters).
-- - quota_state: one row per (workspace, period, limit key) once a threshold is crossed, so each
--   crossing happens at most once per period and recurs the next.
-- - usage_aggregate_cursor: the high-water mark (`received_at`) of usage_event read so far; it
--   moves in the same transaction as the counters, so a crash never counts twice.
--
-- Rows go with their workspace. Named after main's newest migration (20260102002100, B074) instead
-- of the card's 0075_*.

create table usage_counter (
  workspace_id text not null references workspaces (id) on delete cascade,
  period_start timestamptz not null,
  metric text not null check (
    metric in (
      'agent_minutes', 'tokens_in', 'tokens_out', 'queue_items', 'relay_bytes',
      'relay.hosted_minutes', 'relay.queue_items', 'relay.relay_bytes'
    )
  ),
  total bigint not null default 0 check (total >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, period_start, metric)
);

create table quota_state (
  workspace_id text not null references workspaces (id) on delete cascade,
  period_start timestamptz not null,
  limit_key text not null check (limit_key in ('hosted_minutes_month', 'queue_items_month')),
  crossed_80_at timestamptz,
  crossed_100_at timestamptz,
  primary key (workspace_id, period_start, limit_key)
);

create table usage_aggregate_cursor (
  id text primary key check (id ~ '^[a-z_]{1,40}$'),
  high_water timestamptz not null,
  updated_at timestamptz not null default now()
);

-- rollback note: drop table usage_aggregate_cursor; drop table quota_state; drop table
-- usage_counter; usage_event keeps the raw rows, so the counters can be rebuilt.
