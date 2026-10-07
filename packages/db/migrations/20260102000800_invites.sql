-- invites (B029): invitations to join a workspace, by link or bound to an e-mail address.
--
-- The 160-bit token in the invite link is never stored: `token_hash` is its sha256, the column an
-- invite is looked up by. An invite is pending until it is accepted, revoked or expired (its
-- `expires_at`, 7 days by default; the expiry job also sets `expired_at`); its status is computed
-- from those columns. One pending invite per address per workspace.
--
-- `key_bundle` is a host's sealed bundle of session keys for the invitee (CT-CRYPTO §4): opaque
-- ciphertext the server never reads, deleted when the invite expires or is revoked, when the
-- invitee fetches it, or 15 minutes after acceptance (`key_bundle_expires_at`). Rows are purged
-- by the retention lane (B090).
--
-- Named after 20260102000700_workspaces_crud: the runner refuses a file older than an applied one.

create table invites (
  id text primary key check (id ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- A purged workspace's invites are deleted by B029's purge hook, before B027's purge.
  workspace_id text not null references workspaces (id) on delete restrict,
  -- Null for a link invite; else the invitee's address (lower case, CT-IDS).
  email citext check (
    email is null or (char_length(email::text) <= 254 and email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$')
  ),
  role text not null check (role in ('admin', 'member', 'billing', 'guest')),
  token_hash bytea not null check (octet_length(token_hash) = 32),
  created_by text not null references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by text references users (id) on delete restrict,
  revoked_at timestamptz,
  expired_at timestamptz,
  share_history boolean not null default true,
  -- 48 bytes of crypto_box_seal overhead at least; 16 KiB of base64url at most.
  key_bundle bytea check (key_bundle is null or octet_length(key_bundle) between 48 and 12288),
  key_bundle_expires_at timestamptz,
  key_bundle_fetched_at timestamptz,
  constraint invites_token_hash_key unique (token_hash),
  check ((accepted_at is null) = (accepted_by is null)),
  check ((key_bundle is null) or (key_bundle_expires_at is not null))
);

-- Listing a workspace's invites, oldest first.
create index invites_workspace_id_created_at_idx on invites (workspace_id, created_at, id);

-- One pending invite per address per workspace.
create unique index invites_workspace_id_email_key on invites (workspace_id, email)
  where email is not null and accepted_at is null and revoked_at is null and expired_at is null;

-- The expiry job: pending invites by expiry, and bundles by theirs.
create index invites_expires_at_idx on invites (expires_at)
  where accepted_at is null and revoked_at is null and expired_at is null;
create index invites_key_bundle_expires_at_idx on invites (key_bundle_expires_at)
  where key_bundle is not null;

-- rollback note: nothing references invites; drop the table (pending invites stop working and
-- must be sent again).
