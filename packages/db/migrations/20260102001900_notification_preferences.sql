-- Notification preferences (B066, CT-API-NOTIFY `NotificationPreferences`): one document per user,
-- written whole by `PUT /v1/notification-preferences`. A user without a row has the contract
-- defaults, which are code constants, never rows.
--
-- - `doc` is the validated document: channel switches per category and quiet hours. Nothing else
--   is stored (no device names, no tokens). It is at most 8 KiB.
-- - `version` starts at 1 and goes up by one on every write; the ETag is built from it, and a
--   PUT with If-Match compares and sets it in one statement.
--
-- Rows go with their user. Named after main's newest migration (20260102001800, B065) instead of
-- the card's 0066_*.

create table notification_pref (
  user_id text primary key references users (id) on delete cascade,
  doc jsonb not null check (jsonb_typeof(doc) = 'object' and octet_length(doc::text) <= 8192),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version >= 1)
);

-- rollback note: drop table notification_pref; nothing references it, and users fall back to the
-- defaults.
