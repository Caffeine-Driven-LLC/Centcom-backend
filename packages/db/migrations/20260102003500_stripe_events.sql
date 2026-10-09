-- stripe_events (B072): Stripe webhook ingestion, and the billing outbox.
--
-- stripe_event: one row per Stripe event id, written before the webhook is answered 2xx, so a
-- delivery Stripe sees acknowledged is never lost; a duplicate delivery finds the row and does
-- nothing. `payload` is a reduced copy of the event's object (ids, status, amounts, currency):
-- never card data, addresses, e-mail addresses or the signature. `last_error` is a safe code
-- (`unknown_customer`, `stripe_unavailable`, ...), never a message.
--
-- billing_outbox: domain events written while an event is processed, published afterwards:
-- outgoing webhooks (B081's `billing.*` types) and notification requests (B063's
-- `billing_issue`). One row per (type, dedupe_key), so a reprocessed event adds nothing.
--
-- Retention: B090 may delete processed and ignored stripe_event rows after 90 days and published
-- outbox rows after 30 days.

create table stripe_event (
  -- Stripe's own id: evt_ and letters/digits.
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]{1,250}$'),
  type text not null check (type ~ '^[a-z_.]{1,100}$'),
  created_at_stripe timestamptz not null,
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4096
  ),
  status text not null default 'received' check (
    status in ('received', 'processing', 'processed', 'failed', 'ignored')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

-- The sweep finds events still waiting, oldest first.
create index stripe_event_status_received_at_idx on stripe_event (status, received_at);

create table billing_outbox (
  id bigint generated always as identity primary key,
  type text not null check (type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  workspace_id text not null check (workspace_id ~ '^wsp_[0-9A-HJKMNP-TV-Z]{26}$'),
  -- Ids, enums, amounts and currencies only (B081's and B063's allow-lists).
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 2048),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  constraint billing_outbox_type_dedupe_key_key unique (type, dedupe_key)
);

-- The publisher drains unpublished rows in id order.
create index billing_outbox_unpublished_idx on billing_outbox (id) where published_at is null;

-- rollback note: drop table billing_outbox, stripe_event (Stripe redelivers unacknowledged events
-- for 3 days; acknowledged ones can be replayed from Stripe's dashboard).
