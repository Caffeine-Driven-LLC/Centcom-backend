-- queue_session, queue_item (B052, CT-WS-QUEUE): the command-post queue, as the relay keeps it.
--
-- queue_item: one row per item ever submitted to a session's queue, never its body (that is the
-- submit's `ct`, which the relay neither reads nor stores). Only id, submitter, state, size, kind,
-- the agent running it, the order and the seqs: the clear metadata every member already sees in
-- `queue.state`. `position` is the item's index in the order the host set by approving and
-- reordering (null outside it). `held_from` is what a `held` item was before the host left.
--
-- queue_session: per session, the queue's version (`queue.state.version`), whether the host is
-- away, and the last sequenced frame these rows include (`updated_seq`). The relay locks this row
-- (`FOR UPDATE`) while it changes the queue, so two relay nodes never change one queue at once;
-- after a crash it replays the session's frames after `updated_seq`.
--
-- Both cascade from their session so the workspace purge (B027), which deletes session_members
-- then sessions, takes them along; `submitter` is a member id without a foreign key, so the purge's
-- order does not matter for it.

-- The foreign keys briefly lock sessions.
set local lock_timeout = '5s';

create table queue_session (
  session_id text primary key references sessions (id) on delete cascade,
  version bigint not null default 0 check (version >= 0),
  host_away boolean not null default false,
  updated_seq bigint not null default 0 check (updated_seq >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table queue_item (
  session_id text not null references sessions (id) on delete cascade,
  item_id text not null check (item_id ~ '^que_[0-9A-HJKMNP-TV-Z]{26}$'),
  submitter text not null check (submitter ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  state text not null check (
    state in ('queued', 'approved', 'running', 'held', 'done', 'failed', 'canceled', 'rejected', 'dropped')
  ),
  held_from text check (held_from in ('approved', 'running')),
  position integer check (position >= 0),
  -- Ciphertext bytes as the submit declared them (CT-WS-QUEUE rule 8: at most 192 KiB).
  size integer not null check (size between 0 and 196608),
  kind text not null check (kind in ('message', 'command')),
  agent_id text check (agent_id ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- The submit frame's server timestamp.
  ts timestamptz not null,
  created_seq bigint not null check (created_seq >= 1),
  updated_seq bigint not null check (updated_seq >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, item_id)
);

-- rollback note: drop table queue_item, queue_session. Live queues are then rebuilt by replaying
-- each session's buffered frames; items older than the buffer are lost (their frames remain in
-- the durable history).
