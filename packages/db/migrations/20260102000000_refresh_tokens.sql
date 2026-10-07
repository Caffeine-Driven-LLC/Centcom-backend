-- refresh_tokens (B017): rotating refresh tokens with reuse detection (CT-AUTH).
--
-- The token itself is never stored: a row is keyed by the SHA-256 of the token (hex), which is
-- all a presented token is looked up by. Every rotation of one sign-in shares a family; when a
-- spent token is presented again, the whole family is revoked. Rows are never exposed through
-- the API, so they have no CT-IDS id; the family id is an opaque random 128-bit value.
-- Lifetimes: 30 days sliding (`expires_at`, moved on each rotation) within 180 days absolute
-- (`absolute_expires_at`, fixed for the family). Retention: the purge job (B090) deletes rows
-- past `absolute_expires_at`.

create table refresh_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  family_id text not null check (family_id ~ '^[0-9a-f]{32}$'),
  -- The token this one replaced; null for the first token of a family.
  parent_hash text references refresh_tokens (token_hash) on delete restrict,
  user_id text not null references users (id) on delete restrict,
  -- The device the tokens are bound to; null only for clients without a registered device.
  device_id text references devices (id) on delete restrict,
  client_id text not null check (client_id in ('centcom-cli', 'centcom-web', 'centcom-tui')),
  -- Space-separated scopes granted to the family (CT-AUTH).
  scope text not null check (char_length(scope) between 1 and 1000),
  -- The active workspace carried as the access token's `wsp` claim.
  workspace_id text references workspaces (id) on delete restrict,
  created_at timestamptz not null default now(),
  -- Set when the token is rotated: presenting it again is reuse.
  used_at timestamptz,
  expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at <= absolute_expires_at)
);

create index refresh_tokens_family_id_idx on refresh_tokens (family_id);
create index refresh_tokens_user_id_idx on refresh_tokens (user_id);
create index refresh_tokens_device_id_idx on refresh_tokens (device_id);

-- rollback note: nothing references refresh_tokens; drop the table (every signed-in client then
-- has to sign in again).
