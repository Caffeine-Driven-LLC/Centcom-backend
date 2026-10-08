# Releases and update channels

Lane B084 ([CT-API-RELEASES](../../contracts/02-rest-api.md),
[release-manifest.schema.json](../../contracts/schemas/release-manifest.schema.json)). The release
pipeline publishes a signed manifest per channel; installers and the auto-updater read the latest
build for their platform and architecture. Artifacts live on the CDN; the API serves only
manifests and never fetches or proxies a file.

## Reading

Both endpoints are public: no authentication, the anonymous rate limit (30 requests a minute per
address, `RateLimit-*` headers), answers from each API process's memory.

| Endpoint                                            | Answer                                                                                                                                    | `Cache-Control`       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `GET /v1/releases/{channel}/latest?platform=&arch=` | The newest unyanked release with an artifact for that platform and arch: its manifest with only those artifacts, and `min_client_version` | `public, max-age=60`  |
| `GET /v1/releases/{channel}/manifest.json`          | The channel's newest unyanked release, its manifest exactly as published                                                                  | `public, max-age=300` |

- `channel`: `stable`, `beta` or `nightly`; anything else is 404.
- `platform`: `linux`, `darwin` (or `macos`), `win32` (or `windows`); `arch`: `x64` or `arm64`. A
  missing or unknown one is 400 `invalid_request` with the pointer `/platform` or `/arch`; a query
  string over 1 KiB is 400 too.
- No release for the channel (or platform and arch): 404 problem+json, never 200 with null.
- Every answer has an `ETag`; `If-None-Match` with it is 304.
- "Newest" is by version for stable and beta (SemVer, so `1.2.0-rc.1` comes before `1.2.0`) and by
  `released_at` for nightly.

## Publishing

```sh
pnpm release:publish dist/manifest.json --channel stable [--dry-run] [--allow-downgrade]
```

It runs in the release pipeline with a deploy-time database role (`DATABASE_URL`), the release
keys (`RELEASE_PUBKEYS`) and, optionally, `REDIS_URL`. There is no HTTP endpoint for publishing.
It prints one JSON line and exits 0 (published, or already published with the same bytes),
1 (refused or failed: `code`, `detail` and the field pointers) or 2 (usage).

A manifest is published only when all of these hold:

1. It matches the contract schema: `channel`, `version`, `released_at`, `min_supported` (not newer
   than `version`), `artifacts` (platform, arch, kind, url, `sha256` as 64 hex characters, size,
   `sig`, optional `sig_kid`), and nothing else. Fields outside the schema (CI URLs, commit authors,
   host names) are refused, so nothing internal reaches the public manifest. At most 256 KiB.
2. Every URL is HTTPS on a public host name (no address, `localhost` or internal suffix, no
   credentials, query or custom port), and on `RELEASE_ARTIFACT_HOSTS` when that is set.
3. Every artifact's `sig` is an Ed25519 signature (64 bytes, base64url) over the 32 bytes of its
   `sha256`, by the key `sig_kid` names, or by any configured key when it names none. No key, no
   publish: unsigned manifests are never accepted.
4. It would be the channel's newest release (409 otherwise), unless `--allow-downgrade`.
5. The same version is not already published with different bytes (409); the same bytes again
   change nothing.

Then, in one transaction under the channel's lock, the manifest text and its artifacts are stored,
and all but the newest `RELEASE_KEEP_ACTIVE` (20) of the channel are marked `superseded` (kept, not
served). `--dry-run` checks everything and stores nothing; without `DATABASE_URL` it checks the
manifest and signatures only.

### Yanking

`ReleasePublisher.yankRelease(version, channel, reason, actor)` (B087's admin tooling) takes a
release out of `latest` and `manifest.json` without deleting it: its row, manifest and artifacts
stay, with `yanked_at` and the reason. Every API process serves the previous release after its next
refresh (immediately on the `releases:inv` announcement, at most 30 s without it); clients may hold
the old answer for the 60 s max-age.

### Key rotation

`RELEASE_PUBKEYS` lists up to four keys, `kid:<base64url>` or just `<base64url>` (32-byte Ed25519
public keys). To rotate: add the new key next to the old one, sign with the new key (its `sig_kid`),
and remove the old key once no manifest still served needs it. Keys live in configuration, never
in code.

## `status:min_client_version`

The stable channel's newest unyanked release's `min_supported` is kept in Redis under
`status:min_client_version` for the status feed (B086) and client-too-old checks. Publishing or
yanking a stable release writes it at once; beta and nightly never move it. When Redis is down the
manifest is stored anyway, and `MinClientVersionSync` (every 30 s, from Postgres) writes the key
once Redis is back. `latest` answers carry the same value as `min_client_version`.

## Failure modes

| What                    | Effect                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Postgres down           | The last loaded set is served for 60 s; then 503 `service_unavailable`, `retry_after_s: 5` |
| Corrupt stored manifest | That release is skipped (`releases_corrupt_total`), so the previous one is served          |
| Redis down on publish   | The manifest is stored; the min-version key is written by the sync job later               |
| CDN file unreachable    | Not detected here; the updater verifies the hash and signature, so integrity holds         |

## Configuration

| Key                      | Default | Meaning                                                                    |
| ------------------------ | ------- | -------------------------------------------------------------------------- |
| `RELEASE_PUBKEYS`        | none    | Ed25519 public keys signing artifacts, comma-separated, `kid:key` or `key` |
| `RELEASE_KEEP_ACTIVE`    | `20`    | Manifests kept active per channel (1-100)                                  |
| `RELEASE_ARTIFACT_HOSTS` | any     | Host names artifact URLs may use (the CDN)                                 |

Metrics: `releases_published_total{channel}`, `releases_corrupt_total`,
`releases_refresh_failures_total`, `releases_min_version_sync_failures_total`.

## Not here

Building, signing and uploading artifacts (the client's release tooling), the auto-update client,
the status feed (B086), client-too-old enforcement (B038), and staged percentage rollouts
(`rollout_pct` is stored and served, not acted on).
