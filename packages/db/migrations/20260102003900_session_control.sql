-- session_policy, session_mute (B051, CT-WS-CONTROL): what the host's control frames leave behind.
--
-- session_policy: the session's policy from the last accepted `control.policy` (one row per
-- session; a session without one uses the defaults: ask, no shared history, a queue of 20,
-- unlocked). The relay writes it before the frame is sequenced and records the frame's seq once it
-- has one; the queue service (B052) reads it.
--
-- session_mute: the members the host muted, until `until` (null: until unmuted). A row whose
-- `until` has passed is no mute; it stays until the member is muted or unmuted again.
--
-- Key epochs are not here: B049 keeps them in Redis (`relay:ses:{sid}:epoch`), the card's
-- `session_epoch` table would be a second, diverging copy.
--
-- Both cascade from their session (and the mute from its member) so the workspace purge (B027),
-- which deletes session_members then sessions, removes them with it: they are settings of the
-- session, not records to keep.

-- The foreign keys briefly lock sessions and session_members.
set local lock_timeout = '5s';

create table session_policy (
  session_id text primary key references sessions (id) on delete cascade,
  auto_approve text not null default 'ask' check (auto_approve in ('ask', 'trusted', 'everyone')),
  share_history boolean not null default false,
  queue_limit integer not null default 20 check (queue_limit between 0 and 100000),
  locked boolean not null default false,
  auto_failover boolean not null default false,
  -- `mem_` ids (CT-WS-CONTROL `trusted`, `approvers`): at most 50 each, a session's member cap.
  trusted text[] not null default '{}' check (cardinality(trusted) <= 50),
  approvers text[] not null default '{}' check (cardinality(approvers) <= 50),
  queue_paused boolean not null default false,
  -- The seq of the `control.policy` frame that set it; null while that frame is being sequenced.
  updated_seq bigint check (updated_seq >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table session_mute (
  session_id text not null references sessions (id) on delete cascade,
  member_id text not null references session_members (id) on delete cascade,
  "until" timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, member_id)
);

-- rollback note: drop table session_mute, session_policy. Sessions then run with the default
-- policy and nobody muted; nothing else references these tables.
