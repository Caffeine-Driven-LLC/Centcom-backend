-- Data retention (B090): the nightly retention job's run reports and its bookkeeping of the
-- retention it enforces per workspace, so a shortened retention never deletes at once
-- (CT-ENTITLEMENTS "On downgrade": history after 7 days' notice; audit after 7 days).
--
-- - retention_runs: one row per policy per run (what it scanned, purged and skipped, whether it
--   was a dry run, and why it stopped early, if it did). A row left without finished_at belongs
--   to a run that died; the next run of the policy closes it as `interrupted`. Rows finished over
--   90 days ago are purged by the job itself (policy `retention_runs`).
-- - retention_baseline: the days the job enforces for a workspace's dataset (`history`: the
--   smaller of the plan's history_days and the workspace's retention override; `audit`:
--   audit_log_days), written when the job first sees it, when retention grows and when a
--   shortening takes effect.
-- - retention_pending: a shortening recorded and not in effect yet: old_days stay enforced until
--   effective_at (7 days later; for history, 7 days after both the notice to live sessions and the
--   owners' email went out, each marked once sent). Deleted when the shortening takes effect or
--   is withdrawn (retention back to old_days or more).
--
-- Both workspace tables go with their workspace (on delete cascade): they are the job's
-- bookkeeping, not history or audit data, and must never stop B027's purge. Ids, counts, enums
-- and times only.
--
-- Also an index on refresh_tokens (parent_hash): the retention job deletes whole token families,
-- and each deleted token's on-delete-restrict check looks its children up by parent_hash.
--
-- Named after main's newest migration (B053's 20260102004100), later than every open PR's, instead
-- of the card's 090_retention.sql, which the runner refuses.

-- The foreign keys and the index briefly lock workspaces and refresh_tokens.
set local lock_timeout = '5s';

create table retention_runs (
  id bigint generated always as identity primary key,
  policy text not null check (policy ~ '^[a-z][a-z0-9_]{0,39}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  scanned bigint not null default 0 check (scanned >= 0),
  purged bigint not null default 0 check (purged >= 0),
  skipped bigint not null default 0 check (skipped >= 0),
  dry_run boolean not null,
  aborted_reason text check (
    aborted_reason in ('fraction_exceeded', 'budget_exceeded', 'failed', 'interrupted')
  ),
  check (finished_at is null or finished_at >= started_at)
);

-- The latest runs of a policy (the report), and the unfinished ones a new run closes.
create index retention_runs_policy_started_at_idx on retention_runs (policy, started_at desc);

create table retention_baseline (
  workspace_id text not null references workspaces (id) on delete cascade,
  dataset text not null check (dataset in ('history', 'audit')),
  days integer not null check (days >= 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, dataset)
);

create table retention_pending (
  workspace_id text not null references workspaces (id) on delete cascade,
  dataset text not null check (dataset in ('history', 'audit')),
  old_days integer not null check (old_days >= 0),
  new_days integer not null check (new_days >= 0 and new_days < old_days),
  notice_sent_at timestamptz,
  email_sent_at timestamptz,
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, dataset)
);

create index refresh_tokens_parent_hash_idx on refresh_tokens (parent_hash);

-- rollback note: drop index refresh_tokens_parent_hash_idx; drop table retention_pending;
-- drop table retention_baseline; drop table retention_runs; a later run then treats every
-- workspace as first seen (no grace for a shortening it never recorded) and keeps no run reports.
