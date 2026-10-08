-- Staff access to the internal admin API (B087).
--
-- - staff_users: the Centcom staff who may call /internal/admin/v1, one row per user, with a role
--   (support_ro, support_rw, superadmin). A row with disabled_at set counts as no row. A
--   superadmin adds and changes rows through the API (never their own); the first superadmin is
--   inserted by an operator (docs/admin/admin-api.md).
-- - staff_audit_details: the reason (X-Admin-Reason, 10-500 characters) and ticket (X-Admin-Ticket)
--   of each staff call, keyed by its audit event. They are free text, which audit_events' meta must
--   not hold (B036), so they sit beside it, written in the event's transaction. No foreign key:
--   audit_events is append-only and purged on its own schedule (retention, B090, should purge a
--   detail row with its event).
-- - audit_events.actor_type gains 'staff', and a partial index lists the admin API's events
--   (`staff.access`, including calls it refused from non-staff) newest first, for
--   GET /internal/admin/v1/staff-audit.
-- - users.login_disabled_at: set by a staff "disable"; while set, no tokens are issued or refreshed.
-- - refresh_tokens.revoked_reason: 'staff' when staff revoked the token, so presenting it answers
--   token_revoked rather than invalid_grant.
--
-- Named after main's newest migration (20260102002800, B086) instead of the card's 087_*.

-- The ALTERs briefly lock audit_events, users and refresh_tokens.
set local lock_timeout = '5s';

alter table audit_events
  drop constraint audit_events_actor_type_check,
  add constraint audit_events_actor_type_check
    check (actor_type in ('user', 'api_key', 'system', 'device', 'staff'));

create index audit_events_staff_access_created_at_id_idx on audit_events (created_at desc, id desc)
  where action = 'staff.access';

alter table users add column login_disabled_at timestamptz;

alter table refresh_tokens add column revoked_reason text check (revoked_reason in ('staff'));

create table staff_users (
  user_id text primary key references users (id) on delete restrict,
  role text not null check (role in ('support_ro', 'support_rw', 'superadmin')),
  -- The superadmin who added or last changed the row; null for one an operator inserted.
  added_by text references users (id) on delete restrict,
  added_at timestamptz not null default now(),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table staff_audit_details (
  audit_id text primary key check (audit_id ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- Null when the call had no valid reason (it was refused with 422).
  reason text check (char_length(reason) between 10 and 500),
  ticket text check (char_length(ticket) between 1 and 64),
  created_at timestamptz not null default now()
);

-- rollback note: drop table staff_audit_details, staff_users; drop index
-- audit_events_staff_access_created_at_id_idx; alter table refresh_tokens drop column revoked_reason;
-- alter table users drop column login_disabled_at; and restore audit_events_actor_type_check
-- without 'staff' (only once no staff events remain, or the check fails).
