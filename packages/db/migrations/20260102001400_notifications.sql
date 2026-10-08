-- notifications (B063, CT-NOTIF-PAYLOAD): one row per notification a user gets, written by the
-- dispatcher. It holds keys, ids, enums and integers only: `params` is checked against the
-- category's allow-list before it is written, and no display text is ever stored (clients look
-- `notif.<category>.title|body` up in their own message tables).
--
-- - (user_id, event_id) is unique: dispatching one event again writes nothing more.
-- - `dedupe_key`: a second event with the same key for the same user within 10 minutes is
--   dropped. The window slides, so it is checked under an advisory lock, not by an index.
-- - `channels`: where the dispatcher sent it; the inbox lists rows holding `inbox`.
-- - `digest_pending`: low/normal items for the e-mail channel wait for the hourly digest, which
--   clears it and sets `digest_sent_at`.
--
-- Rows go with their user (B026's account deletion deletes them first: the foreign key
-- restricts). Named after the lanes in review (20260102000900 to 20260102001300).

create table notifications (
  id text primary key check (id ~ '^ntf_[0-9A-HJKMNP-TV-Z]{26}$'),
  user_id text not null references users (id) on delete restrict,
  event_id text not null check (event_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  category text not null check (
    category in (
      'trial_ending', 'approval_needed', 'queue_turn', 'mention', 'member_joined',
      'member_left', 'agent_done', 'ci_failed', 'pr_merged', 'usage_warning', 'quota_reached',
      'billing_issue', 'invite_received', 'update_available', 'security_alert'
    )
  ),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  priority text not null check (priority in ('low', 'normal', 'high')),
  action jsonb check (action is null or jsonb_typeof(action) = 'object'),
  channels text[] not null check (channels <@ array['inbox', 'push', 'email', 'os']::text[]),
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) between 1 and 128),
  digest_pending boolean not null default false,
  digest_sent_at timestamptz,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_user_id_event_id_key unique (user_id, event_id)
);

-- The inbox, newest first.
create index notifications_user_id_created_at_idx on notifications (user_id, created_at, id);
-- The dedupe window.
create index notifications_user_id_dedupe_key_created_at_idx
  on notifications (user_id, dedupe_key, created_at)
  where dedupe_key is not null;
-- The digest's work.
create index notifications_digest_pending_idx
  on notifications (user_id, created_at)
  where digest_pending;

-- rollback note: nothing references notifications; drop the table (inboxes are then empty and
-- pending digest items are lost).
