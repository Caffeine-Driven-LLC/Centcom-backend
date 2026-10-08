-- projects (B035): named references to a repository inside a workspace (CT-API-WORKSPACES).
--
-- `repo_ref` is an opaque identifier the client chooses (CT-API-WORKSPACES: clients SHOULD send a
-- hash of the normalised remote, never the URL); the API refuses anything that looks like a local
-- path, a URL with credentials or a token, so none is ever stored. The server never reads a
-- repository. Names are unique per workspace ignoring case; `version` is the ETag, moved on by
-- every change.
--
-- Named 20260102001000: 20260102000900 went to device_grants (B016), and the runner refuses two
-- files with one version.

create table projects (
  id text primary key check (id ~ '^prj_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- A purged workspace's projects are deleted by B035's purge hook, before B027's purge.
  workspace_id text not null references workspaces (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 60),
  repo_ref text check (repo_ref is null or char_length(repo_ref) between 1 and 128),
  created_by text not null references users (id) on delete restrict,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One name per workspace, ignoring case (`Api` and `api` conflict).
create unique index projects_workspace_id_name_key on projects (workspace_id, lower(name));

-- Listing a workspace's projects, oldest first.
create index projects_workspace_id_created_at_idx on projects (workspace_id, created_at, id);

-- rollback note: nothing references projects; drop the table (clients lose their project names
-- and must create them again).
