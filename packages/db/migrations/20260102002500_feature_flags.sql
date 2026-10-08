-- Feature flags and remote config (B083, CT-API-FLAGS).
--
-- - feature_flags: one row per flag. `value` is served to callers its rules let in, `default_value`
--   to everyone else (and to everyone while `kill` is set). Both are JSON of the flag's `type`
--   (a boolean, a string, a number or an object). `rules` is a JSON array of targeting rules
--   (percent rollout, plans, workspace allow-list, client version range), all of which must pass.
--   `public` flags may be shown to anonymous callers; `server_only` flags are never sent to clients.
-- - feature_flags_meta: the global revision, one row. Every change to a flag adds exactly 1 to it
--   in the same transaction, so a cache knows it is current by comparing one number.
--
-- No secrets or personal data: keys are checked against a denylist (`secret`, `token`, `key`, ...)
-- and values against B036's secret and address patterns before they are stored. `updated_by` is a
-- `usr_` or `key_` id.
--
-- Named after main's newest migration (20260102002400, B082) instead of the card's 083_*.

create table feature_flags (
  key text primary key check (key ~ '^[a-z0-9_.-]{1,64}$'),
  type text not null check (type in ('bool', 'string', 'number', 'json')),
  value jsonb not null check (octet_length(value::text) <= 8192),
  default_value jsonb not null check (octet_length(default_value::text) <= 8192),
  public boolean not null default false,
  server_only boolean not null default false,
  kill boolean not null default false,
  rules jsonb not null default '[]'::jsonb check (
    jsonb_typeof(rules) = 'array' and octet_length(rules::text) <= 65536
  ),
  updated_by text not null check (char_length(updated_by) between 1 and 64),
  updated_at timestamptz not null default now(),
  check (not (public and server_only))
);

create table feature_flags_meta (
  id boolean primary key default true check (id),
  rev bigint not null default 0 check (rev >= 0)
);

insert into feature_flags_meta (id, rev) values (true, 0);

-- rollback note: drop table feature_flags, feature_flags_meta; callers then get no flags (an
-- empty set at rev 0 once the API no longer reads them).
