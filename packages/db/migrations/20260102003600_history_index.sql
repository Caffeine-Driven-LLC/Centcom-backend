-- history_index (B055, CT-RESUME): the index of a session's durable ciphertext history. The frames
-- themselves are in the object store, batched in `history/<ses_>/<first seq>-<last seq>.bin`;
-- a row says where one frame is and nothing about its content.
--
-- Privacy (CT-RESUME "What the server stores about history"): exactly seq, id, from, ts, the kind
-- class (event|queue|control), size, kid and the blob key. No text, path, branch name or payload
-- column, ever: `history.privacy.test.ts` fails when a column outside that list appears.
--
-- history_retention: when a session's history may be purged (`history_days` of its plan, counted
-- from the session's end); the retention job (B090) acts on it.
--
-- Both reference sessions with ON DELETE RESTRICT: a session's history is purged (blobs first,
-- then rows) before the session row goes.

-- The foreign keys briefly lock sessions.
set local lock_timeout = '5s';

create table history_index (
  session_id text not null references sessions (id) on delete restrict,
  seq bigint not null check (seq >= 1),
  -- The frame's id (CT-IDS: msg_ for events, que_ for queue items, ...).
  msg_id text not null check (msg_id ~ '^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- The sender: a session member, or `srv` for frames the relay emits.
  member_id text not null check (member_id ~ '^(mem_[0-9A-HJKMNP-TV-Z]{26}|srv)$'),
  ts timestamptz not null,
  kind_class text not null check (kind_class in ('event', 'queue', 'control')),
  -- Bytes of the stored frame in its blob.
  size integer not null check (size between 1 and 1048576),
  -- The epoch key id of `ct` (CT-CRYPTO); null for a frame without `ct`.
  kid text check (char_length(kid) between 1 and 64),
  blob_key text not null check (
    char_length(blob_key) <= 100
    and blob_key ~ '^history/ses_[0-9A-HJKMNP-TV-Z]{26}/[0-9]{1,19}-[0-9]{1,19}\.bin$'
  ),
  primary key (session_id, seq)
);

-- Purge and crash repair look rows up by blob.
create index history_index_blob_key_idx on history_index (blob_key);

create table history_retention (
  session_id text primary key references sessions (id) on delete restrict,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The retention job finds expired histories.
create index history_retention_expires_at_idx on history_retention (expires_at);

-- rollback note: purge every session's history first (its blobs are only reachable through these
-- rows), then drop table history_retention, history_index.
