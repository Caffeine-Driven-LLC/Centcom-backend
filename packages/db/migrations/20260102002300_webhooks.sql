-- Outgoing webhooks (B081, CT-API-WEBHOOKS, CT-WEBHOOKS): endpoints, the events fanned out to
-- them, one delivery per (event, endpoint) with its attempts, and an outbox for events emitted
-- while Redis was down.
--
-- - webhook_endpoints: the signing secret is stored sealed (AES-256-GCM, bound to the endpoint id),
--   and during a rotation's 24 h overlap the previous one too. `status` is the contract's
--   (active, failing, disabled); `failing_since` dates the current run of failed attempts.
-- - webhook_events: an event once, its `data` checked against CT-WEBHOOKS (ids, enums, counts and
--   names only). Retries and redeliveries send the same body from it.
-- - webhook_deliveries: `id` is the payload's `id` and `Centcom-Event-Id`, the same on every
--   attempt. Only the event id and type, the last attempt's result and at most 1 KiB of the
--   receiver's answer are kept; no request body.
-- - webhook_outbox: events waiting for Redis, drained in id order.
--
-- Rows go with their workspace or endpoint. Named after main's newest migration (20260102002200,
-- B075) instead of the card's 081_*.

create table webhook_endpoints (
  id text primary key check (id ~ '^whk_[0-9A-HJKMNP-TV-Z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  url text not null check (char_length(url) between 1 and 2048),
  events text[] not null check (cardinality(events) between 1 and 32),
  enabled boolean not null default true,
  status text not null default 'active' check (status in ('active', 'failing', 'disabled')),
  secret_enc jsonb not null,
  prev_secret_enc jsonb,
  prev_secret_expires_at timestamptz,
  secret_rotated_at timestamptz,
  failing_since timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((prev_secret_enc is null) = (prev_secret_expires_at is null))
);

create index webhook_endpoints_workspace_id_created_at_idx
  on webhook_endpoints (workspace_id, created_at, id);

create table webhook_events (
  id text primary key check (char_length(id) between 1 and 64),
  workspace_id text not null references workspaces (id) on delete cascade,
  type text not null check (type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4096),
  created_at timestamptz not null
);

create index webhook_events_created_at_idx on webhook_events (created_at);

create table webhook_deliveries (
  id text primary key check (id ~ '^dlv_[0-9A-HJKMNP-TV-Z]{26}$'),
  endpoint_id text not null references webhook_endpoints (id) on delete cascade,
  event_id text not null references webhook_events (id) on delete cascade,
  event_type text not null,
  attempt integer not null default 0 check (attempt >= 0),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  last_error text check (
    last_error is null or last_error in (
      'timeout', 'connection', 'redirect', 'http_status', 'blocked_destination',
      'secret_unavailable', 'endpoint_disabled'
    )
  ),
  response_excerpt text check (response_excerpt is null or char_length(response_excerpt) <= 1024),
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, endpoint_id)
);

create index webhook_deliveries_endpoint_id_created_at_idx
  on webhook_deliveries (endpoint_id, created_at, id);

create table webhook_outbox (
  id bigint generated always as identity primary key,
  event jsonb not null check (jsonb_typeof(event) = 'object'),
  created_at timestamptz not null default now()
);

-- rollback note: drop table webhook_outbox; drop table webhook_deliveries; drop table
-- webhook_events; drop table webhook_endpoints; receivers then get nothing more.
