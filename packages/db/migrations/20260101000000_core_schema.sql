-- core_schema (B008): the tables every identity, workspace and session lane builds on.
--
-- Rows hold metadata only: no message text, file paths or branch names (GUIDELINES §5.3), no
-- passwords or secrets. E-mail is the only personal data besides the display name. Ids are CT-IDS
-- prefixed ULIDs made by the application. Users are never deleted by cascade: deletion is a job
-- (B026), and every reference to a user blocks deleting it.

-- Case-insensitive e-mail addresses. citext is a trusted extension: the database owner may
-- create it; a role without that right makes this migration fail with "permission denied".
create extension if not exists citext;

create table users (
  id text primary key check (id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- Lower-cased by the API (CT-IDS); citext also makes uniqueness ignore case.
  email citext not null check (
    char_length(email::text) <= 254 and email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  display_name text not null check (char_length(display_name) between 1 and 40),
  -- BCP 47 tag.
  locale text not null default 'en' check (
    char_length(locale) <= 35 and locale ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'
  ),
  -- The avatar slot identifier the API calls `avatar` (CT-API-ACCOUNTS: a string of up to 64).
  avatar_slot text check (char_length(avatar_slot) between 1 and 64),
  telemetry_opt_in boolean not null default false,
  status text not null default 'active' check (status in ('active', 'pending_deletion', 'deleted')),
  deletion_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_email_key unique (email)
);

create table devices (
  id text primary key check (id ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text not null references users (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  platform text not null check (platform in ('linux', 'macos', 'windows', 'web', 'other')),
  -- 32-byte public keys, base64url without padding (CT-IDS, CT-CRYPTO): X25519 wraps keys,
  -- Ed25519 signs frames.
  x25519_pub text not null check (x25519_pub ~ '^[A-Za-z0-9_-]{43}$'),
  ed25519_pub text not null check (ed25519_pub ~ '^[A-Za-z0-9_-]{43}$'),
  -- CT-CRYPTO fingerprint of the two keys, as shown to users: ABCD-EFGH-IJKL (base32).
  fingerprint text not null check (fingerprint ~ '^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$'),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index devices_user_id_idx on devices (user_id);

create table workspaces (
  id text primary key check (id ~ '^wsp_[0-9A-HJKMNP-TV-Z]{26}$'),
  name text not null check (char_length(name) between 1 and 60),
  slug text not null check (slug ~ '^[a-z0-9-]{3,40}$'),
  -- CT-API-WORKSPACES WorkspaceSettings, validated by the service layer.
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- Incremented on every change; the ETag of the workspace (CT-PAGE conditional requests).
  version integer not null default 1 check (version >= 1),
  created_by text not null references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Unique across soft-deleted workspaces too (unlike CONVENTIONS' partial-index default): a slug
  -- stays reserved until the purge job removes the row, so a deleted workspace's links cannot be
  -- taken over.
  constraint workspaces_slug_key unique (slug)
);

create table memberships (
  id text primary key check (id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  workspace_id text not null references workspaces (id) on delete restrict,
  user_id text not null references users (id) on delete restrict,
  -- CT-RBAC workspace roles.
  role text not null check (role in ('owner', 'admin', 'member', 'billing', 'guest')),
  created_at timestamptz not null default now(),
  -- Its index, led by workspace_id, also serves lookups by workspace.
  constraint memberships_workspace_id_user_id_key unique (workspace_id, user_id)
);

create index memberships_user_id_idx on memberships (user_id);

create table sessions (
  id text primary key check (id ~ '^ses_[0-9A-HJKMNP-TV-Z]{26}$'),
  workspace_id text references workspaces (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  state text not null default 'pending' check (
    state in ('pending', 'live', 'paused', 'ended', 'expired')
  ),
  -- Relay region, such as eu or us.
  region text not null check (region ~ '^[a-z][a-z0-9-]{1,31}$'),
  created_by text not null references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create index sessions_workspace_id_idx on sessions (workspace_id);

create table session_members (
  id text primary key check (id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  session_id text not null references sessions (id) on delete restrict,
  user_id text not null references users (id) on delete restrict,
  device_id text not null references devices (id) on delete restrict,
  -- CT-RBAC session roles.
  role text not null check (role in ('host', 'editor', 'viewer')),
  slot integer not null check (slot >= 0),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  constraint session_members_session_id_slot_key unique (session_id, slot)
);

-- rollback note: before any real data exists, drop table session_members, sessions, memberships,
-- workspaces, devices, users (in that order), then drop extension citext if nothing else uses it.
-- Once data exists this migration is never undone; later changes are new migrations.
