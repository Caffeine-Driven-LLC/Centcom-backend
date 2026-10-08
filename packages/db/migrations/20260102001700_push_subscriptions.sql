-- push_subscriptions (B064, CT-API-NOTIFY "push"): where a user's notifications are pushed: a
-- web-push endpoint with its keys, or an APNs or FCM device token. One row per user and
-- endpoint/token (`token_hash`, SHA-256 of the endpoint or token), at most 10 per user (the
-- registry enforces it under a row lock on the user).
--
-- - `token_enc` and `keys_enc` are the endpoint/token and the web-push keys (`p256dh`, `auth`),
--   sealed with AES-256-GCM (PUSH_ENCRYPTION_KEY) and bound to the row id: neither is stored in
--   clear, returned or logged.
-- - `failures` counts consecutive failed sends since `failing_since`; the fifth within 24 h
--   deletes the row. A success resets both.
--
-- Rows go with their user (B026's account deletion deletes them first: the foreign keys
-- restrict). Named after main's newest migration (20260102001600, B030), not the card's 0064_*.

create table push_subscriptions (
  id text primary key check (id ~ '^psh_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text not null references users (id) on delete restrict,
  kind text not null check (kind in ('web_push', 'apns', 'fcm')),
  device_id text references devices (id) on delete restrict,
  token_hash bytea not null check (octet_length(token_hash) = 32),
  token_enc jsonb not null check (jsonb_typeof(token_enc) = 'object'),
  keys_enc jsonb check (keys_enc is null or jsonb_typeof(keys_enc) = 'object'),
  failures integer not null default 0 check (failures >= 0),
  failing_since timestamptz,
  created_at timestamptz not null default now(),
  constraint push_subscriptions_user_id_token_hash_key unique (user_id, token_hash),
  check ((kind = 'web_push') = (keys_enc is not null))
);

-- The unique constraint's index, led by user_id, also serves "a user's subscriptions".

-- rollback note: drop table push_subscriptions; nothing references it.
