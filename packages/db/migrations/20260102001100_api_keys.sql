-- api_keys (B019, CT-AUTH): machine credentials of one workspace, `cen_live_…` / `cen_test_…`.
--
-- The key is shown once, when it is made, and never stored: `key_hash` is sha256(pepper ‖ key)
-- with the server's API_KEY_PEPPER, so a copy of this table does not let anyone check a guessed
-- key. `prefix` is the key's first 12 characters (`cen_live_Ab3`), for people to tell keys apart.
-- A key is usable until it is revoked, it expires, or its workspace is deleted. Revoked and
-- expired rows are purged by the retention lane (B090).
--
-- Named after 20260102000800_invites: the runner refuses a file older than an applied one (and
-- 20260102000900 and 20260102001000 are taken by lanes in review).

create table api_keys (
  id text primary key check (id ~ '^key_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- A key is the workspace's credential and means nothing without it: purging the workspace
  -- (B027, after its soft delete already disabled the key) deletes its keys. Not history or audit
  -- (packages/db/CONVENTIONS.md), so the cascade is allowed.
  workspace_id text not null references workspaces (id) on delete cascade,
  created_by text not null references users (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 60),
  mode text not null check (mode in ('live', 'test')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  prefix text not null check (prefix ~ '^cen_(live|test)_[0-9A-Za-z]{3}$'),
  -- Space-separated CT-AUTH scopes, never `admin`.
  scope text not null check (
    char_length(scope) between 1 and 512 and scope !~ '(^| )admin( |$)'
  ),
  created_at timestamptz not null default now(),
  -- Updated at most once a minute per key.
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint api_keys_key_hash_key unique (key_hash),
  -- `cen_live_…` keys are live keys, `cen_test_…` test keys.
  constraint api_keys_prefix_mode_check check (substr(prefix, 5, 4) = mode)
);

-- Listing a workspace's keys, newest first; and counting its live ones under the limit.
create index api_keys_workspace_id_created_at_idx on api_keys (workspace_id, created_at, id);
-- A user's own keys.
create index api_keys_created_by_idx on api_keys (created_by);

-- rollback note: nothing references api_keys; drop the table (every key stops working, and
-- automation must be given new ones).
