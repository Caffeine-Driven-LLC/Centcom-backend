-- Release manifests (B084, CT-API-RELEASES).
--
-- - releases: one row per published manifest of a channel. `manifest` is the manifest exactly as it
--   was published (text, never jsonb, so it is served byte for byte), `manifest_sha256` its digest.
--   The newest RELEASE_KEEP_ACTIVE (20) of a channel are `active`; older ones are `superseded`.
--   A yanked release keeps its row (`yanked_at`, `yank_reason`) and is no longer served as latest.
-- - release_artifacts: the manifest's artifacts, one row per platform, arch and kind: HTTPS CDN
--   URLs (never proxied), their SHA-256 and their Ed25519 signature over it, verified at publish.
--
-- Named after main's newest migration (20260102002500, B083) instead of the card's 084_*.

create table releases (
  channel text not null check (channel in ('stable', 'beta', 'nightly')),
  version text not null check (
    char_length(version) <= 64 and version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'
  ),
  released_at timestamptz not null,
  min_supported text not null check (char_length(min_supported) <= 64),
  manifest text not null check (octet_length(manifest) <= 262144),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'superseded')),
  yanked_at timestamptz,
  yank_reason text check (char_length(yank_reason) <= 200),
  published_by text not null check (char_length(published_by) between 1 and 64),
  published_at timestamptz not null default now(),
  primary key (channel, version)
);

create index releases_channel_active_idx on releases (channel) where status = 'active';

create table release_artifacts (
  channel text not null,
  version text not null,
  platform text not null check (platform in ('linux', 'darwin', 'win32')),
  arch text not null check (arch in ('x64', 'arm64')),
  kind text not null default 'binary' check (kind in ('binary', 'npm', 'archive')),
  url text not null check (url ~ '^https://' and char_length(url) <= 2048),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size > 0),
  sig text not null check (char_length(sig) <= 128),
  sig_kid text check (char_length(sig_kid) <= 64),
  primary key (channel, version, platform, arch, kind),
  foreign key (channel, version) references releases (channel, version) on delete cascade
);

-- rollback note: drop table release_artifacts, releases; the CDN files are untouched, and
-- clients keep their installed version until manifests are published again.
