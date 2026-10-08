-- The public status feed's incidents and deprecations (B086, CT-STATUS).
--
-- - status_incidents: one row per incident (`inc_` id), its title, status (`investigating`,
--   `identified`, `monitoring`, `resolved`) and the components it affects (ids from
--   STATUS_COMPONENTS). Resolved incidents leave the feed 7 days after `resolved_at`.
-- - status_incident_updates: an incident's updates, in order. Text is at most 500 characters and
--   must not hold customer data (the service refuses e-mail and IP addresses and credentials).
-- - status_deprecations: what is deprecated and its sunset date (`what` is the key).
--
-- Named after main's newest migration (20260102002700, B085) instead of the card's 086_*.

create table status_incidents (
  id text primary key check (id ~ '^inc_[0-9A-HJKMNP-TV-Z]{26}$'),
  title text not null check (char_length(title) between 1 and 120),
  status text not null check (status in ('investigating', 'identified', 'monitoring', 'resolved')),
  component_ids text[] not null default '{}' check (cardinality(component_ids) <= 50),
  started_at timestamptz not null,
  resolved_at timestamptz,
  check ((status = 'resolved') = (resolved_at is not null))
);

create index status_incidents_open_idx on status_incidents (started_at) where resolved_at is null;
create index status_incidents_resolved_at_idx on status_incidents (resolved_at)
  where resolved_at is not null;

create table status_incident_updates (
  id bigint generated always as identity primary key,
  incident_id text not null references status_incidents (id) on delete cascade,
  at timestamptz not null,
  text text not null check (char_length(text) between 1 and 500),
  status text check (status in ('investigating', 'identified', 'monitoring', 'resolved'))
);

create index status_incident_updates_incident_id_idx on status_incident_updates (incident_id, at, id);

create table status_deprecations (
  what text primary key check (char_length(what) between 1 and 200),
  sunset date not null,
  created_at timestamptz not null default now()
);

-- rollback note: drop table status_incident_updates, status_incidents, status_deprecations; the
-- feed then shows components only.
