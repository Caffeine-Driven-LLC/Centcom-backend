-- plans and entitlements (B069, CT-ENTITLEMENTS): the plans, their limits, and each workspace's
-- entitlement state.
--
-- `plans` and `plan_limits` hold CT-ENTITLEMENTS §3's reference values, seeded below and kept equal
-- to apps/api/src/modules/entitlements/seed-plans.ts (a test compares the two, and both with the
-- contract's table). A limit is one row per (plan, key): the two flags in `bool_value`, counts in
-- `int_value` (null: unlimited). Prices are not here: they are product configuration in
-- seed-plans.ts.
--
-- `workspace_entitlements` holds the subscription state B070-B078 apply (plan, status, period, the
-- grace end of a past-due subscription, add-on seats), its revision `rev` (CT-AUTH's `ent` claim)
-- and `resolved_digest`: the sha256 of the {plan, status, limits} that `rev` was issued for, so
-- `rev` moves only when those change. Every workspace has a row: this file backfills the live ones
-- (free, none, rev 0); the API writes one on a workspace's first read or change.
--
-- Named after 20260102001400_notifications: the runner refuses a file older than an applied one.

create table plans (
  id text primary key check (id in ('free', 'pro', 'team')),
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plan_limits (
  plan_id text not null references plans (id) on delete restrict,
  -- CT-ENTITLEMENTS §2's keys; a new key is a contract change.
  key text not null check (key in (
    'relay_access', 'lan_multiplayer', 'max_seats', 'max_session_members',
    'max_concurrent_sessions', 'max_parallel_agents', 'history_days', 'hosted_minutes_month',
    'queue_items_month', 'audit_log_days', 'webhooks_max', 'api_keys_max'
  )),
  bool_value boolean,
  int_value integer check (int_value is null or int_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (plan_id, key),
  -- The two flags are booleans; every other key is a count (null: unlimited).
  check (
    case when key in ('relay_access', 'lan_multiplayer')
      then bool_value is not null and int_value is null
      else bool_value is null
    end
  ),
  -- LAN multiplayer is never gated (CT-ENTITLEMENTS §2).
  check (key <> 'lan_multiplayer' or bool_value)
);

create table workspace_entitlements (
  -- A purged workspace's row is deleted by B069's purge hook, before B027's purge.
  workspace_id text primary key references workspaces (id) on delete restrict,
  plan_id text not null default 'free' references plans (id) on delete restrict,
  status text not null default 'none'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'none')),
  period_start timestamptz,
  period_end timestamptz,
  -- When a past-due subscription's 7 days of grace end.
  grace_until timestamptz,
  addon_seats integer not null default 0 check (addon_seats between 0 and 100000),
  rev integer not null default 0 check (rev >= 0),
  -- Null until first resolved: the free plan's limits with status none.
  resolved_digest bytea check (resolved_digest is null or octet_length(resolved_digest) = 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((period_start is null) = (period_end is null)),
  check (period_end is null or period_end > period_start),
  check ((status = 'past_due') = (grace_until is not null))
);

insert into plans (id, name) values ('free', 'Free'), ('pro', 'Pro'), ('team', 'Team');

insert into plan_limits (plan_id, key, bool_value, int_value) values
  ('free', 'relay_access', false, null),
  ('free', 'lan_multiplayer', true, null),
  ('free', 'max_seats', null, 1),
  ('free', 'max_session_members', null, 8),
  ('free', 'max_concurrent_sessions', null, 0),
  ('free', 'max_parallel_agents', null, 4),
  ('free', 'history_days', null, 0),
  ('free', 'hosted_minutes_month', null, 0),
  ('free', 'queue_items_month', null, null),
  ('free', 'audit_log_days', null, 0),
  ('free', 'webhooks_max', null, 0),
  ('free', 'api_keys_max', null, 1),
  ('pro', 'relay_access', true, null),
  ('pro', 'lan_multiplayer', true, null),
  ('pro', 'max_seats', null, 1),
  ('pro', 'max_session_members', null, 4),
  ('pro', 'max_concurrent_sessions', null, 2),
  ('pro', 'max_parallel_agents', null, 8),
  ('pro', 'history_days', null, 7),
  ('pro', 'hosted_minutes_month', null, 6000),
  ('pro', 'queue_items_month', null, null),
  ('pro', 'audit_log_days', null, 0),
  ('pro', 'webhooks_max', null, 2),
  ('pro', 'api_keys_max', null, 5),
  ('team', 'relay_access', true, null),
  ('team', 'lan_multiplayer', true, null),
  ('team', 'max_seats', null, 5),
  ('team', 'max_session_members', null, 12),
  ('team', 'max_concurrent_sessions', null, 10),
  ('team', 'max_parallel_agents', null, 16),
  ('team', 'history_days', null, 30),
  ('team', 'hosted_minutes_month', null, 30000),
  ('team', 'queue_items_month', null, null),
  ('team', 'audit_log_days', null, 90),
  ('team', 'webhooks_max', null, 20),
  ('team', 'api_keys_max', null, 50);

-- Every live workspace starts on the free plan with no subscription.
insert into workspace_entitlements (workspace_id)
  select id from workspaces where deleted_at is null;

-- rollback note: drop workspace_entitlements, plan_limits and plans, in that order; nothing else
-- references them. Entitlements are unavailable until the file is applied again.
