-- reaction and comment_ref (B062, CT-WS-SESSION-EVENTS reaction / comment.add): reactions as a
-- queryable per-target set, and an index of comments that points at their frames in the history.
--
-- Privacy (CT-WS-SESSION-EVENTS "What the relay may read"): a reaction is cleartext (target,
-- code, op); a comment is encrypted (its target and text are inside `ct`), so `comment_ref`
-- holds only where the comment is in the log (seq, frame id), who sent it, the size of its `ct`
-- and the key id. No text column, ever: `comments.index.test.ts` fails when one appears.
--
-- Columns beyond the card's list: `reaction.removed` (a remove keeps the row as a tombstone at
-- its seq, so frames applied out of order still end in the state of the highest seq: a later add
-- never revives a reaction its member removed after it) and `reaction.updated_at`. `comment_ref`
-- has no `target`: the target is inside `ct` (CT-WS-SESSION-EVENTS catalogue, comment.add).
--
-- The card names the file `0062_reactions_comments.sql`; the migration runner accepts only
-- 14-digit versions, so it is the next one after main's and every open PR's newest.
--
-- Cascades from its session, like B051's, B052's and B057's session tables: reactions and
-- comment pointers are part of the session's history and go with it.

-- The foreign keys briefly lock sessions.
set local lock_timeout = '5s';

create table reaction (
  session_id text not null references sessions (id) on delete cascade,
  target text not null check (target ~ '^msg_[0-9A-HJKMNP-TV-Z]{26}$'),
  code text not null check (code in ('thumbs', 'heart', 'party', 'laugh', 'eyes', 'check')),
  member_id text not null check (member_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  seq bigint not null check (seq >= 1),
  removed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (session_id, target, code, member_id)
);

-- Aggregates by target: the live reactions of a session's targets.
create index reaction_target_idx on reaction (session_id, target) where not removed;

create table comment_ref (
  session_id text not null references sessions (id) on delete cascade,
  seq bigint not null check (seq >= 1),
  msg_id text not null check (char_length(msg_id) between 1 and 40),
  member_id text not null check (member_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  size integer not null check (size between 1 and 196608),
  kid text not null check (char_length(kid) between 1 and 64),
  created_at timestamptz not null default now(),
  primary key (session_id, seq)
);

-- One pointer per frame (a replayed frame id lands on the same row).
create unique index comment_ref_frame_idx on comment_ref (session_id, member_id, msg_id);

-- rollback note: drop table comment_ref; drop table reaction. Nothing else refers to them.
