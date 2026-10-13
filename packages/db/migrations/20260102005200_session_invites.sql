-- session_invites (B105): an invitation to ONE session, as editor or viewer, without workspace
-- membership and without a seat.
--
-- Same shape as `invites` (B029): only the sha256 of the 160-bit token is stored; the status is
-- computed from the columns and the time. An accepted, not revoked row is the grant: it lets the
-- person it names (`accepted_by`) join this session at `role`, nothing else. `key_bundle` is the
-- host's sealed bundle of session keys for the invitee (opaque ciphertext, CT-CRYPTO section 4),
-- deleted when fetched, on revocation or expiry, or 15 minutes after acceptance.
--
-- Named after 20260102005100: the runner refuses a file older than an applied one.

create table session_invites (
  id text primary key check (id ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'),
  session_id text not null references sessions (id) on delete cascade,
  -- Denormalised from the session so the invite is readable without it (and stays with its workspace).
  workspace_id text references workspaces (id) on delete restrict,
  email citext check (
    email is null or (char_length(email::text) <= 254 and email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$')
  ),
  role text not null check (role in ('editor', 'viewer')),
  token_hash bytea not null check (octet_length(token_hash) = 32),
  created_by text not null references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by text references users (id) on delete restrict,
  revoked_at timestamptz,
  expired_at timestamptz,
  share_history boolean not null default true,
  key_bundle bytea check (key_bundle is null or octet_length(key_bundle) between 48 and 12288),
  key_bundle_expires_at timestamptz,
  key_bundle_fetched_at timestamptz,
  constraint session_invites_token_hash_key unique (token_hash),
  check ((accepted_at is null) = (accepted_by is null)),
  check ((key_bundle is null) or (key_bundle_expires_at is not null))
);

create index session_invites_session_id_created_at_idx on session_invites (session_id, created_at, id);

-- One pending invite per address per session.
create unique index session_invites_session_email_key on session_invites (session_id, email)
  where email is not null and accepted_at is null and revoked_at is null and expired_at is null;

-- The grant lookup: a user's live grants.
create index session_invites_grant_idx on session_invites (session_id, accepted_by)
  where accepted_by is not null and revoked_at is null;

create index session_invites_expires_at_idx on session_invites (expires_at)
  where accepted_at is null and revoked_at is null and expired_at is null;

-- rollback note: nothing references session_invites; drop the table (pending invites stop working
-- and grants are withdrawn; members already in a session keep their rows until they leave).
