-- workspaces CRUD (B027): the sole-owner invariant in the database. A workspace has at most one
-- `owner` membership, enforced here rather than only in code; creating a workspace inserts it
-- together with its owner in one transaction, so every workspace has exactly one. Soft-deleted
-- workspaces keep their memberships until the purge job removes them, so the index covers them.
--
-- The workspaces table itself (with `version`, the ETag source, and `deleted_at`) is B008's.
--
-- Named after 20260102000600_audit_events: the runner refuses a file older than an applied one.

-- Building the index briefly locks memberships.
set local lock_timeout = '5s';

create unique index memberships_workspace_id_owner_key on memberships (workspace_id)
  where role = 'owner';

-- rollback note: drop index memberships_workspace_id_owner_key (the code still creates one owner
-- per workspace; only the database's guarantee goes).
