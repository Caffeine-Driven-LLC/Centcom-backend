-- workspace_settings (B034, CT-API-WORKSPACES `WorkspaceSettings`): a workspace's policies, the
-- defaults a host client applies to its sessions through `control.policy` (the server never pushes
-- them into a live session). No row means the defaults: auto_approve `ask`, share_history true,
-- no retention override. `version` moves on with every change; it is the settings' ETag.
--
-- retention_days only shortens retention: the API refuses a value above the plan's history_days
-- (CT-ENTITLEMENTS), and the retention job uses the smaller of the two. auto_approve takes exactly
-- the values of CT-WS-QUEUE rule 3 / `control.policy`.
--
-- A deleted workspace's row is removed by the `workspace-settings` hook of B027's purge, before
-- the workspace row. Named after the lanes in review (20260102000900 to 20260102001200): the
-- runner refuses a file older than an applied one.

create table workspace_settings (
  workspace_id text primary key references workspaces (id) on delete restrict,
  auto_approve text not null default 'ask'
    check (auto_approve in ('ask', 'trusted', 'everyone')),
  share_history boolean not null default true,
  retention_days integer check (retention_days >= 0),
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now()
);

-- rollback note: nothing references workspace_settings; drop the table (every workspace then reads
-- the defaults, and the retention job falls back to the plan's history_days).
