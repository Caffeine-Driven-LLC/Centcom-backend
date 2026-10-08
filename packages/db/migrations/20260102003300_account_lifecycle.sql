-- account_lifecycle (B026, CT-API-ACCOUNTS): account deletion with a 30-day grace period, and
-- downloadable exports of a user's own data.
--
-- users: `deletion_scheduled_at` is when the purge job may remove the account (request + 30 d),
-- `deleted_at` when it did. A purged user whose id other people's records still point at
-- (a workspace they created, a session they joined) keeps a scrubbed row: status `deleted`, no
-- name, no e-mail of theirs. B008's `deletion_requested_at` stays the time of the request.
--
-- account_exports: one row per export request. The file lives in the object store under
-- `blob_key` (`exports/<usr>/<exp>.json`) until `expires_at` (7 days after it was written); the
-- row says only how it went. Retention: rows go with the user's purge; B090 may delete expired
-- rows older than 30 days.
--
-- Audit pseudonymisation: audit_events is append-only (B036). The purge rewrites the deleted
-- user's id to the constant `usr_deleted` through pseudonymise_audit_user(), a SECURITY DEFINER
-- function that allows its own UPDATE through a transaction-local setting, honoured only for the
-- table's owner, exactly as purge_audit_events() does for retention deletes.

-- The foreign key and the new columns briefly lock users and audit_events.
set local lock_timeout = '5s';

alter table users
  add column deletion_scheduled_at timestamptz,
  add column deleted_at timestamptz;

create table account_exports (
  id text primary key check (id ~ '^exp_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text not null references users (id) on delete restrict,
  -- `running` while a worker builds it; CT-API-ACCOUNTS shows it as `pending`.
  status text not null default 'pending' check (
    status in ('pending', 'running', 'ready', 'failed', 'expired')
  ),
  blob_key text check (char_length(blob_key) between 1 and 200),
  size_bytes bigint check (size_bytes >= 0),
  -- A safe code (`storage_unavailable`, `internal`) when the export failed; never a message.
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- When the file stops being downloadable; set when it is written.
  expires_at timestamptz
);

-- The 24-hour limit and the purge look up a user's exports, newest first.
create index account_exports_user_id_created_at_idx on account_exports (user_id, created_at desc);
-- The sweep finds ready exports whose file has expired.
create index account_exports_status_expires_at_idx on account_exports (status, expires_at);

create or replace function audit_events_append_only() returns trigger
language plpgsql
as $$
declare
  owner_name text := (select pg_get_userbyid(relowner) from pg_class where oid = tg_relid);
begin
  if tg_op = 'DELETE'
    and current_setting('centcom.audit_purge', true) = 'on'
    and current_user = owner_name
  then
    return null;
  end if;
  if tg_op = 'UPDATE'
    and current_setting('centcom.audit_pseudonymise', true) = 'on'
    and current_user = owner_name
  then
    return null;
  end if;
  raise exception 'audit_events is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege',
          hint = 'Retention deletes through purge_audit_events(); account purges pseudonymise through pseudonymise_audit_user().';
end;
$$;

-- Replaces p_user_id with `usr_deleted` wherever it is the actor or the target of an event, and
-- returns how many rows changed. Running it again changes nothing. Executable by the owner only.
create function pseudonymise_audit_user(p_user_id text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  changed integer;
begin
  if p_user_id is null or p_user_id !~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$' then
    raise exception 'pseudonymise_audit_user: p_user_id must be a usr_ id'
      using errcode = 'invalid_parameter_value';
  end if;
  perform set_config('centcom.audit_pseudonymise', 'on', true);
  update audit_events
    set actor_id = case
          when actor_type = 'user' and actor_id = p_user_id then 'usr_deleted' else actor_id end,
        target_id = case
          when target_type = 'user' and target_id = p_user_id then 'usr_deleted' else target_id end
    where (actor_type = 'user' and actor_id = p_user_id)
       or (target_type = 'user' and target_id = p_user_id);
  get diagnostics changed = row_count;
  perform set_config('centcom.audit_pseudonymise', 'off', true);
  return changed;
end;
$$;

revoke all on function pseudonymise_audit_user(text) from public;

-- rollback note: drop function pseudonymise_audit_user(text); restore B036's
-- audit_events_append_only() from 20260102000600_audit_events.sql (create or replace); drop table
-- account_exports (delete the files under exports/ in the object store first); then drop the
-- users columns deletion_scheduled_at and deleted_at. Rewritten audit ids cannot be restored.
