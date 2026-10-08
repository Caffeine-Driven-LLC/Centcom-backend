-- The audit API (B082, CT-API-AUDIT): indexes for its filters, and export jobs.
--
-- - B036's (workspace_id, created_at desc, id desc) serves the unfiltered list. These two serve the
--   `actor` and `action` filters as range scans, newest first, so a filtered page stays fast in a
--   workspace with millions of events.
-- - audit_export_jobs: one row per export (CSV or JSON of a filter set, and the retention horizon
--   when it was asked for; events after `created_at` are left out). Status pending, running,
--   ready, failed or expired. The file is written once, whole, to object storage under
--   `object_key`, and deleted at `expires_at` (24 h after it was written). `error` is a safe reason
--   code, never a message.
--
-- Named after main's newest migration (20260102002200, B075), skipping 20260102002300, which B081's
-- open PR uses, instead of the card's 082_*.

-- The two indexes lock audit_events against writes while they build: on a large, busy table,
-- build them by B092's procedure first.
set local lock_timeout = '5s';

create index audit_events_workspace_id_actor_id_created_at_idx
  on audit_events (workspace_id, actor_id, created_at desc, id desc);
create index audit_events_workspace_id_action_created_at_idx
  on audit_events (workspace_id, action, created_at desc, id desc);

create table audit_export_jobs (
  id text primary key check (id ~ '^exp_[0-9A-HJKMNP-TV-Z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  requested_by text not null check (char_length(requested_by) between 1 and 64),
  format text not null check (format in ('csv', 'json')),
  gzip boolean not null default false,
  filters jsonb not null check (jsonb_typeof(filters) = 'object'),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'ready', 'failed', 'expired')),
  row_count integer check (row_count is null or row_count >= 0),
  object_key text check (object_key is null or char_length(object_key) <= 512),
  error text check (error is null or error in ('row_cap_exceeded', 'storage_unavailable', 'internal')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz
);

create index audit_export_jobs_workspace_id_created_at_idx
  on audit_export_jobs (workspace_id, created_at desc);
create index audit_export_jobs_ready_expires_at_idx
  on audit_export_jobs (expires_at) where status = 'ready';

-- rollback note: drop table audit_export_jobs; drop index
-- audit_events_workspace_id_action_created_at_idx; drop index
-- audit_events_workspace_id_actor_id_created_at_idx; export files left in object storage are then
-- unreferenced.
