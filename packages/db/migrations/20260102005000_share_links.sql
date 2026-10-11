-- share_link, guest_member (B068, CT-API-SESSIONS share links, CT-CRYPTO §4a, CT-RBAC
-- "Share-link guests"): viewer-only links a host hands out, and the anonymous guests who joined
-- through them.
--
-- share_link: the token is never stored, only its SHA-256 (`token_hash`, unique: the join looks a
-- link up by it). A link lives at most 24 h (CT-DEEPLINK), may be used `max_uses` times (at most
-- 50), and can be revoked. `uses` is raised by a conditional UPDATE (`uses < max_uses`), so
-- concurrent joins never pass the cap. The E2E key travels in the URL fragment and never reaches
-- the server.
--
-- guest_member: a guest who joined through a link. Its `mem_` id is the member id of its relay
-- ticket (role viewer, no device). Guests are not session_members rows: they have no user and no
-- device. They count toward `max_session_members`. They are deleted when their link is revoked
-- or expires, or the session ends (`ShareLinkService.sweep`), and with their link or session.
--
-- Both cascade from their session (the workspace purge, B027, deletes sessions), and guests from
-- their link.

set local lock_timeout = '5s';

create table share_link (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references sessions (id) on delete cascade,
  -- SHA-256 of the token (32 bytes).
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  expires_at timestamptz not null,
  max_uses integer not null check (max_uses between 1 and 50),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  revoked_at timestamptz,
  -- The host's session member who created it.
  created_by_member text not null check (created_by_member ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '24 hours')
);

create index share_link_session_idx on share_link (session_id);

create table guest_member (
  member_id text primary key check (member_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  session_id text not null references sessions (id) on delete cascade,
  share_link_id uuid not null references share_link (id) on delete cascade,
  -- The display name the guest gave (1-40 characters, CT-IDS Text).
  name text not null check (char_length(name) between 1 and 40),
  slot integer not null check (slot between 0 and 49),
  created_at timestamptz not null default now()
);

create index guest_member_session_idx on guest_member (session_id);
create index guest_member_link_idx on guest_member (share_link_id);

-- rollback note: drop table guest_member, share_link. Links already handed out then fail to join
-- (404), and connected guests keep their relay connection until it closes.
