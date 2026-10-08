-- Opt-in telemetry (B085, CT-TELEMETRY).
--
-- - telemetry_events: scrubbed events, partitioned by the UTC day they were received, one table
--   per day (telemetry_events_YYYYMMDD). No IP address, user id, device, workspace or request id
--   is stored: only the per-install `install_id` (a random ULID the client can reset), the event
--   type, its time and its allow-listed props. Raw events are kept 90 days.
-- - telemetry_daily_agg: counts per day, event type and key (`*` for all events of the type,
--   `<prop>=<value>` for string and boolean props). Kept after the raw events are dropped.
-- - telemetry_rollups: one row per rolled-up day, so a day is rolled up exactly once.
-- - telemetry_ensure_partition(day) and telemetry_drop_partitions(before) create and drop the day
--   tables. They run as the owner (SECURITY DEFINER), so the API and the worker need no DDL rights.
--
-- Named after main's newest migration (20260102002600, B084) instead of the card's 085_*.

create table telemetry_events (
  day date not null,
  install_id text not null check (install_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  type text not null check (type in (
    'app.start', 'app.exit', 'command.run', 'session.created', 'session.joined',
    'agent.state_change', 'feature.used', 'error.shown', 'perf.startup', 'perf.frame',
    'update.result'
  )),
  at timestamptz not null,
  props jsonb not null default '{}'::jsonb check (
    jsonb_typeof(props) = 'object' and octet_length(props::text) <= 1024
  )
) partition by range (day);

create table telemetry_daily_agg (
  day date not null,
  type text not null,
  key text not null check (char_length(key) between 1 and 160),
  count bigint not null check (count >= 0),
  primary key (day, type, key)
);

create table telemetry_rollups (
  day date primary key,
  rolled_up_at timestamptz not null default now()
);

create function telemetry_ensure_partition(p_day date) returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_day is null then
    raise exception 'telemetry_ensure_partition: a day is required'
      using errcode = 'invalid_parameter_value';
  end if;
  execute format(
    'create table if not exists public.%I partition of public.telemetry_events for values from (%L) to (%L)',
    'telemetry_events_' || to_char(p_day, 'YYYYMMDD'), p_day, p_day + 1
  );
exception
  -- Another session created it at the same moment.
  when duplicate_table or unique_violation then null;
end;
$$;

create function telemetry_drop_partitions(p_before date) returns setof text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  part text;
begin
  if p_before is null then
    raise exception 'telemetry_drop_partitions: a day is required'
      using errcode = 'invalid_parameter_value';
  end if;
  for part in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    where p.oid = 'public.telemetry_events'::regclass
      and c.relnamespace = 'public'::regnamespace
      and c.relname ~ '^telemetry_events_[0-9]{8}$'
      and to_date(substr(c.relname, 18), 'YYYYMMDD') < p_before
    order by c.relname
  loop
    execute format('drop table public.%I', part);
    return next part;
  end loop;
end;
$$;

revoke all on function telemetry_ensure_partition(date) from public;
revoke all on function telemetry_drop_partitions(date) from public;

-- rollback note: drop the two functions and the three tables (raw events and aggregates go with
-- them; clients keep answering 204).
