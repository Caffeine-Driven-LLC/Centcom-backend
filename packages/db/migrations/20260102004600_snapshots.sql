-- snapshot (B056, CT-RESUME "Snapshot rules", CT-API-SESSIONS): the descriptors of a session's
-- encrypted state checkpoints. The bytes are in the object store at `snapshots/<ses_>/<snp_>.bin`,
-- uploaded by the host through a pre-signed PUT; the server only checks their size and SHA-256.
--
-- A row is `pending` from begin until a commit verified its object, then `committed`. Pruning
-- marks a row `deleting` before it deletes the object and then the row, so a pruning that stops
-- halfway is finished by the next one and GET never returns a descriptor whose object is gone.
--
-- Columns: `size` is the size the host declared at begin (the pre-signed PUT is bound to it) and
-- that the commit verified; `seq`, `sha256` (`sha256:<hex>`, CT-IDS) and `kid` (CT-CRYPTO epoch
-- key id) are set by the commit. Nothing else about the content, ever: `snapshots.privacy.test.ts`
-- fails when another column appears.
--
-- The card names the file `0056_snapshots.sql`; the migration runner accepts only 14-digit
-- versions, so it is the next one after main's and every open PR's newest.
--
-- References sessions with ON DELETE RESTRICT, like B055's history: a session's snapshots are
-- purged (objects first, then rows; `SnapshotService.purgeSession`, for B090) before it goes.

-- The foreign key briefly locks sessions.
set local lock_timeout = '5s';

create table snapshot (
  snp text primary key check (snp ~ '^snp_[0-9A-HJKMNP-TV-Z]{26}$'),
  session_id text not null references sessions (id) on delete restrict,
  state text not null default 'pending' check (state in ('pending', 'committed', 'deleting')),
  seq bigint check (seq >= 0),
  size integer not null check (size between 0 and 33554432),
  sha256 text check (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  kid text check (char_length(kid) between 1 and 64),
  blob_key text not null unique check (
    blob_key ~ '^snapshots/ses_[0-9A-HJKMNP-TV-Z]{26}/snp_[0-9A-HJKMNP-TV-Z]{26}\.bin$'
  ),
  created_at timestamptz not null,
  committed_at timestamptz,
  -- A committed snapshot has its descriptor.
  check (state <> 'committed' or (seq is not null and sha256 is not null and kid is not null
    and committed_at is not null))
);

-- The latest committed snapshot of a session, and the keep-3 pruning (newest seq first).
create index snapshot_session_committed_idx on snapshot (session_id, seq desc, committed_at desc)
  where state = 'committed';
-- The pending cap per session, and the 15 min expiry of uploads never committed.
create index snapshot_pending_idx on snapshot (session_id, created_at) where state = 'pending';
create index snapshot_pending_created_idx on snapshot (created_at) where state = 'pending';
-- Rows whose deletion stopped halfway.
create index snapshot_deleting_idx on snapshot (session_id) where state = 'deleting';

-- rollback note: drop table snapshot (its indexes go with it). The objects under `snapshots/`
-- stay in the bucket; delete that prefix when the rollback is meant to remove the data.
