-- Session lifecycle (B053, CT-API-SESSIONS, CT-WS-CONTROL "Host failover"): the columns the state
-- machine needs on `sessions`, and the outbox of its transitions.
--
-- sessions:
--   host_member_id     the host's session member (`mem_`), set at create and by a transfer or
--                      failover; no foreign key, because session_members references sessions;
--   host_connected     whether the host has a relay connection (the relay tells the API);
--   last_host_seen_at  when the host was last connected (a new session: its creation, so the
--                      10 min host-absent grace also covers a host that never connects);
--   paused_at          when the session last became paused; expires_at is paused_at + 24 h;
--   end_reason         why it ended: done, abandoned, error (the host or an admin), or expired;
--   updated_at         the last change.
-- Every transition is a conditional UPDATE (`WHERE state = expected`), so two API or worker
-- instances can never both win one.
--
-- session_outbox: one row per transition, written in the transition's transaction and delivered
-- after the commit: `control.session_state` to the relay, and the `session.*` domain event (for
-- webhooks) when the transition has one. Rows not delivered are retried with backoff by the
-- expiry sweep. It cascades from its session; sessions themselves are never deleted here
-- (retention jobs own deletion).

set local lock_timeout = '5s';

alter table sessions
  add column host_member_id text check (host_member_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  add column host_connected boolean not null default false,
  add column last_host_seen_at timestamptz not null default now(),
  add column paused_at timestamptz,
  add column expires_at timestamptz,
  add column end_reason text check (end_reason in ('done', 'abandoned', 'error', 'expired')),
  add column updated_at timestamptz not null default now();

-- The sweep finds live sessions whose host has been gone past the grace, and paused ones past 24 h.
create index sessions_host_absent_idx on sessions (last_host_seen_at)
  where state = 'live' and not host_connected;
create index sessions_paused_expiry_idx on sessions (expires_at) where state = 'paused';
-- Listing a workspace's sessions, newest first (ULID desc), and counting its active ones.
create index sessions_workspace_state_idx on sessions (workspace_id, state, id);

create table session_outbox (
  id bigint generated always as identity primary key,
  session_id text not null references sessions (id) on delete cascade,
  -- The state the transition reached (CT-WS-CONTROL control.session_state).
  state text not null check (state in ('pending', 'live', 'paused', 'ended', 'expired')),
  -- The domain event, when the transition has one (CT-WEBHOOKS session.created/started/ended),
  -- and its id: fixed, so a redelivery is the same event (webhook fan-out dedupes by it).
  event_type text check (event_type in ('session.created', 'session.started', 'session.ended')),
  event_id uuid not null default gen_random_uuid(),
  relay_sent_at timestamptz,
  event_sent_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index session_outbox_pending_idx on session_outbox (next_attempt_at)
  where relay_sent_at is null or (event_type is not null and event_sent_at is null);

-- rollback note: drop table session_outbox; drop the indexes sessions_host_absent_idx,
-- sessions_paused_expiry_idx and sessions_workspace_state_idx; then drop the added sessions
-- columns (host_member_id, host_connected, last_host_seen_at, paused_at, expires_at, end_reason,
-- updated_at). Transitions then stop being recorded for redelivery.
