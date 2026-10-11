-- presence_log and member_last_seen (B067, CT-WS-PRESENCE): connection facts only. When a member
-- came online in a session (its first connection after being offline) and went offline (its last
-- connection closed and stayed closed for the presence grace, 10 s), and when it was last seen.
--
-- Privacy: CT-WS-PRESENCE keeps presence ephemeral ("never stored durably"), so no presence payload
-- is stored: no status, activity, cursor, path or name column (`presence-history.privacy.test.ts`
-- fails when one appears). `presence_log` rows are kept 30 days (PII minimisation): the in-lane
-- purge (`purgeOlderThan`) deletes older ones, scheduled by B090.
--
-- Columns beyond the card's list: `presence_log.id` (a row id for the batches) and
-- `member_last_seen.connected` (whether the member was connected at its last write, so `lastSeen`
-- can answer "now" for a member online; a write older than three touch intervals no longer counts
-- as online, so a crashed node cannot keep a member online).
--
-- The card names the file `0067_presence_history.sql`; the migration runner accepts only 14-digit
-- versions, so it is the next one after main's and every open PR's newest (B062's 004800).
--
-- Cascades from its session, like the other session tables: the log and the last-seen rows are
-- part of the session's history and go with it. A member who left (kicked) keeps its rows.

-- The foreign keys briefly lock sessions.
set local lock_timeout = '5s';

create table presence_log (
  id bigint generated always as identity primary key,
  session_id text not null references sessions (id) on delete cascade,
  member_id text not null check (member_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  device_id text check (device_id ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
  event text not null check (event in ('connected', 'disconnected')),
  reason text check (reason in ('closed', 'timeout', 'kicked')),
  at timestamptz not null,
  -- A disconnect says why; a connect does not.
  check ((event = 'disconnected') = (reason is not null))
);

-- The purge: rows older than the cutoff.
create index presence_log_at_idx on presence_log (at);
-- A member's history in a session.
create index presence_log_member_idx on presence_log (session_id, member_id, at);

create table member_last_seen (
  session_id text not null references sessions (id) on delete cascade,
  member_id text not null check (member_id ~ '^mem_[0-9A-HJKMNP-TV-Z]{26}$'),
  device_id text check (device_id ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
  last_seen_at timestamptz not null,
  connected boolean not null,
  primary key (session_id, member_id)
);

-- A device's recent sessions.
create index member_last_seen_device_idx on member_last_seen (device_id, last_seen_at desc);

-- rollback note: drop table member_last_seen; drop table presence_log. Nothing else refers to them.
