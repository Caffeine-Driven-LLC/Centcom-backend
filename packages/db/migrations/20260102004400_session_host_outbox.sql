-- session_host_outbox (B054, CT-API-SESSIONS claim-host, CT-WS-CONTROL control.host_changed): the
-- host changes `POST /v1/sessions/{id}/claim-host` made, to tell the relay. A row is written in
-- the claim's transaction and delivered after the commit; a relay notifier that is down leaves it
-- here, retried with backoff (B054's card, failure mode "relay notifier down during claim-host:
-- change committed, notification queued via outbox, response still 200").
--
-- The message carries the session's current host, so a late retry never names an old one. A row
-- is deleted once delivered (nothing reads it after), so the table holds only pending changes;
-- it cascades from its session.

set local lock_timeout = '5s';

create table session_host_outbox (
  id bigint generated always as identity primary key,
  session_id text not null references sessions (id) on delete cascade,
  -- CT-WS-CONTROL control.host_changed `code`: a claim while the host is gone is a failover.
  code text not null check (code in ('failover')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Due rows, oldest first; a session's rows (delivery after a claim, the cascade).
create index session_host_outbox_due_idx on session_host_outbox (next_attempt_at);
create index session_host_outbox_session_idx on session_host_outbox (session_id);

-- rollback note: drop table session_host_outbox. Host claims then stop being queued for the
-- relay; the relay still reads the host from the records on the next connection.
