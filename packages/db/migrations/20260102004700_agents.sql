-- agent (B057, CT-WS-SESSION-EVENTS agent.spawn / agent.state / agent.exit): the relay's agent
-- registry, written through from its Redis copy on every change, so it can be rebuilt after a
-- restart and keeps the history of each agent's lifetime.
--
-- Privacy (CT-WS-SESSION-EVENTS "What the relay may read"): agent ids, the owning member, the
-- mode, the state name, the frame seqs and the outcome only. Never a label, branch, worktree or
-- model (they stay inside `ct`): `agents.privacy.test.ts` fails when a column outside this list
-- appears.
--
-- Columns beyond the card's list: `spawn_frame_id` and `spawned_by` (the spawn frame's `msg_` id
-- and sender, so only that member's resend of it is recognised, after a restart too) and
-- `rev` (from the `agent_rev_seq` sequence at every write: the Redis copy's watermark, so a copy
-- older than the table is rebuilt; a sequence, not a clock, so two writes never tie) and
-- `updated_at`. `since` is kept as the frame gave it (text), so the rebuilt
-- registry answers exactly what it answered before.
--
-- The card names the file `0057_agents.sql`; the migration runner accepts only 14-digit versions,
-- so it is the next one after main's and every open PR's newest.
--
-- Cascades from its session, like B051's and B052's session tables: an agent row is part of its
-- session's history and goes with it (workspace purge, B090's retention).

-- The foreign key briefly locks sessions.
set local lock_timeout = '5s';

-- Every write of an agent row takes the next value: the order of writes across the cluster.
create sequence agent_rev_seq;

create table agent (
  session_id text not null references sessions (id) on delete cascade,
  agent_id text not null check (agent_id ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
  owner_member text not null check (owner_member ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  mode text not null check (mode in ('command_post', 'branch')),
  state text not null check (char_length(state) <= 64),
  since text not null check (char_length(since) between 1 and 40),
  spawned_seq bigint not null check (spawned_seq >= 1),
  spawn_frame_id text not null check (char_length(spawn_frame_id) between 1 and 40),
  spawned_by text not null check (spawned_by ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  exited_seq bigint check (exited_seq >= 1),
  outcome text check (outcome in ('ok', 'error', 'canceled')),
  error_code text check (char_length(error_code) between 1 and 64),
  rev bigint not null default nextval('agent_rev_seq'),
  updated_at timestamptz not null default now(),
  primary key (session_id, agent_id),
  -- An exited agent has its outcome and seq; a live one neither.
  check ((exited_seq is null) = (outcome is null)),
  check (error_code is null or outcome is not null)
);

-- The watermark: the newest write of a session.
create index agent_session_rev_idx on agent (session_id, rev);

-- rollback note: drop table agent; drop sequence agent_rev_seq. The registry's Redis copies (relay:agents:<sid>) expire on
-- their own (48 h).
