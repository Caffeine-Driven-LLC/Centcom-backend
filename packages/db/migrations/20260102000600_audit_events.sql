-- audit_events (B036): the append-only audit log (CT-API-AUDIT). Every state-changing path writes
-- here through @centcom/core's audit emitter, in the same transaction as its change, or in the
-- background where there is no transaction (the relay, refusals). The audit API (B082) reads it.
--
-- Privacy (GUIDELINES §5.3): rows hold ids, enums and counts. The emitter keeps only the meta keys
-- each action allows and redacts secret-like values; no message text, path, branch name, token,
-- key, ciphertext, IP or e-mail address is stored.
--
-- Append-only: a statement-level trigger refuses UPDATE, DELETE and TRUNCATE for every role,
-- the table's owner included. Retention (B090) deletes old rows only through purge_audit_events(),
-- a SECURITY DEFINER function that allows its own DELETE through a transaction-local setting,
-- honoured only for the table's owner (whom the function runs as). This stops application code;
-- an owner can still drop the trigger, so the API should run as a role that does not own tables.
-- CONVENTIONS' "no triggers" is about updated_at: here the trigger is the guarantee itself, which
-- must hold whatever code runs.
--
-- Named after 20260102000500_login_tokens: the runner refuses a file older than an applied one.

-- The foreign key briefly locks workspaces.
set local lock_timeout = '5s';

create table audit_events (
  id text primary key check (id ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- Null for events outside any workspace. Never cascades (CONVENTIONS): a workspace row goes only
  -- after retention has purged its audit events.
  workspace_id text references workspaces (id) on delete restrict,
  actor_type text not null check (actor_type in ('user', 'api_key', 'system', 'device')),
  -- A usr_, key_ or dev_ id, or a service's name for system actors (the emitter checks which).
  actor_id text not null check (char_length(actor_id) between 1 and 64),
  action text not null check (
    char_length(action) <= 64 and action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
  ),
  target_type text check (target_type ~ '^[a-z][a-z0-9_]{0,31}$'),
  target_id text check (char_length(target_id) between 1 and 40),
  outcome text not null check (outcome in ('success', 'denied', 'failed')),
  request_id text check (request_id ~ '^req_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- At most 2 KiB as the emitter writes it; jsonb's text form adds spaces, hence the margin.
  meta jsonb not null default '{}'::jsonb check (
    jsonb_typeof(meta) = 'object' and octet_length(meta::text) <= 4096
  ),
  -- When the event happened (the emitter's clock), not when a background batch was written.
  created_at timestamptz not null default now(),
  check ((target_type is null) = (target_id is null))
);

-- The audit API lists a workspace's events newest first, by keyset on (created_at, id).
create index audit_events_workspace_id_created_at_id_idx
  on audit_events (workspace_id, created_at desc, id desc);

create function audit_events_append_only() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
    and current_setting('centcom.audit_purge', true) = 'on'
    and current_user = (select pg_get_userbyid(relowner) from pg_class where oid = tg_relid)
  then
    return null;
  end if;
  raise exception 'audit_events is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege',
          hint = 'Retention deletes through purge_audit_events().';
end;
$$;

create trigger audit_events_append_only
  before update or delete or truncate on audit_events
  for each statement execute function audit_events_append_only();

-- Deletes up to p_limit events of one workspace (null: events outside any workspace) created
-- before p_before, oldest first, and returns how many. Executable by the owner only: grant it to
-- the retention job's role where that is another role.
create function purge_audit_events(p_workspace_id text, p_before timestamptz, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  purged integer;
begin
  if p_before is null or p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'purge_audit_events: p_before is required and p_limit must be 1 to 10000'
      using errcode = 'invalid_parameter_value';
  end if;
  perform set_config('centcom.audit_purge', 'on', true);
  if p_workspace_id is null then
    delete from audit_events where id in (
      select id from audit_events
      where workspace_id is null and created_at < p_before
      order by created_at
      limit p_limit
    );
  else
    delete from audit_events where id in (
      select id from audit_events
      where workspace_id = p_workspace_id and created_at < p_before
      order by created_at
      limit p_limit
    );
  end if;
  get diagnostics purged = row_count;
  perform set_config('centcom.audit_purge', 'off', true);
  return purged;
end;
$$;

revoke all on function purge_audit_events(text, timestamptz, integer) from public;

-- rollback note: nothing references audit_events; drop the trigger, the two functions and the
-- table by hand (the audit history goes with them: export it first if it must be kept).
