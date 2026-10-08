-- device_grants (B016): RFC 8628 device authorization grants, one row per
-- `POST /v1/auth/device/code`.
--
-- Only sha256(device_code) is kept: the device_code is the secret the terminal polls with. The
-- user_code is short and shown on screen; it is kept normalised (8 characters, no hyphen) and is
-- unique among pending grants. A row lives 10 minutes: one user approves or denies it, then the
-- poll that finds it approved creates the device and its tokens and marks it consumed, in one
-- transaction. The public keys and device name are what the terminal sent; they become the
-- `devices` row. Expired and finished rows are purged by the retention lane (B090). Rows are never
-- exposed through the API, so the key is the hash, not a CT-IDS id.
--
-- Named after 20260102000800_invites: the runner refuses a file older than an applied one.

create table device_grants (
  device_code_hash text primary key check (device_code_hash ~ '^[0-9a-f]{64}$'),
  -- CT-AUTH alphabet: A-Z and 2-9 without 0, O, 1, I and L.
  user_code text not null check (user_code ~ '^[A-HJKMNP-Z2-9]{8}$'),
  client_id text not null check (client_id in ('centcom-cli', 'centcom-web', 'centcom-tui')),
  -- Space-separated scopes, already narrowed to what the client may hold.
  scope text not null check (char_length(scope) between 1 and 512),
  device_name text not null check (char_length(device_name) between 1 and 80),
  platform text not null check (platform in ('linux', 'macos', 'windows', 'web', 'other')),
  x25519_pub text not null check (x25519_pub ~ '^[A-Za-z0-9_-]{43}$'),
  ed25519_pub text not null check (ed25519_pub ~ '^[A-Za-z0-9_-]{43}$'),
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'denied', 'consumed')
  ),
  -- Who approved or denied the grant; set together with the status.
  user_id text references users (id) on delete restrict,
  -- The device the consuming poll created.
  device_id text references devices (id) on delete restrict,
  -- The poll interval; slow_down adds 5 seconds.
  interval_s integer not null default 5 check (interval_s between 5 and 60),
  -- Set from the API's clock (not now()), like the expiry checks, so the two always agree.
  last_polled_at timestamptz,
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint device_grants_user_id_status_check check ((status = 'pending') = (user_id is null)),
  constraint device_grants_device_id_status_check check (
    (status = 'consumed') = (device_id is not null)
  )
);

-- A user_code names one pending grant; once decided, the code may be handed out again.
create unique index device_grants_user_code_key on device_grants (user_code)
  where status = 'pending';

create index device_grants_expires_at_idx on device_grants (expires_at);

-- rollback note: nothing but the device flow uses device_grants; drop the table (flows in
-- progress then fail and terminals start again). Devices it created stay.
