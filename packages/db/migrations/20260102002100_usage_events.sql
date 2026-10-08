-- Usage events (B074, CT-API-USAGE): what devices report through `POST /v1/usage/events`, one row
-- per (workspace, event id), append-only. B075 aggregates them.
--
-- - The primary key (workspace_id, event_id) dedupes: a re-sent event is not stored again, and a
--   client can only collide with ids of the workspace it reports into.
-- - Only the contract fields, the reporting device and the receive time are stored; no message,
--   path or other content.
-- - (workspace_id, type, at) serves B075's aggregation; received_at serves its sweep for rows a
--   missed hint did not announce.
--
-- Rows go with their workspace. Named instead of the card's 0074_* after main's newest migration
-- (20260102001900, B066), skipping 20260102002000, which B070's open PR uses.

create table usage_event (
  workspace_id text not null references workspaces (id) on delete cascade,
  event_id text not null check (event_id ~ '^use_[0-9A-HJKMNP-TV-Z]{26}$'),
  type text not null check (
    type in ('agent_minutes', 'tokens_in', 'tokens_out', 'queue_items', 'relay_bytes')
  ),
  qty bigint not null check (qty >= 0),
  at timestamptz not null,
  session_id text check (session_id is null or session_id ~ '^ses_[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id text check (agent_id is null or agent_id ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
  device_id text not null check (device_id ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
  received_at timestamptz not null default now(),
  primary key (workspace_id, event_id)
);

create index usage_event_workspace_id_type_at_idx on usage_event (workspace_id, type, at);
create index usage_event_received_at_idx on usage_event (received_at);

-- rollback note: drop table usage_event; reported usage is lost (B075's aggregates keep totals).
