# Release manifests (B084)

The update channels of [CT-API-RELEASES](../../../../../contracts/02-rest-api.md): signed release
manifests published by the release pipeline and served to installers and the auto-updater. The
operator's guide is [docs/platform/releases.md](../../../../../docs/platform/releases.md).

## Pieces

| File             | What it does                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `manifest.ts`    | `parseManifest` (schema, fields, URLs, versions; text kept) and `verifySignatures` (Ed25519).       |
| `config.ts`      | `RELEASE_PUBKEYS` (two keys at once for rotation), `RELEASE_KEEP_ACTIVE`, `RELEASE_ARTIFACT_HOSTS`. |
| `repository.ts`  | `releases` and `release_artifacts`; inserts under the channel's advisory lock.                      |
| `publisher.ts`   | `ReleasePublisher.publishRelease` and `yankRelease`.                                                |
| `cache.ts`       | `ReleaseCache`: answers built ahead, refreshed every 30 s and on `releases:inv`.                    |
| `min-version.ts` | `status:min_client_version` from the stable channel; `MinClientVersionSync` retries every 30 s.     |
| `cli.ts`         | `runPublishCli`: `pnpm release:publish` (script `apps/api/scripts/publish-release.ts`).             |

Routes: `routes/releases.ts`. Migration: `20260102002600_releases.sql`.

## Wiring

```ts
const repository = createReleaseRepository(db);
const cache = new ReleaseCache({ repository, pubsub: redis.pubsub, logger, metrics });
await cache.start(); // cache.stop() on close
await app.register(releaseRoutes, { releases: cache });
const sync = new MinClientVersionSync({
  load: () => repository.loadActive(),
  kv: redis.kv,
  logger,
  metrics,
});
sync.start(); // sync.stop() on close
```

The rate-limit plugin (B023) applies the anonymous bucket (30 a minute per address) to these routes
like any other. Publishing has no HTTP route: the pipeline runs `pnpm release:publish` with a
deploy-time database role; B087's admin tooling may construct a `ReleasePublisher`.

## Rules

- **Visible only when verified:** every artifact's `sig` must verify (Ed25519 over the 32 bytes of
  its `sha256`) with the configured key its `sig_kid` names, or any configured key. Without keys
  nothing can be published, in any environment.
- **Byte-stable:** the manifest's text is stored as `text` and served verbatim as `manifest.json`.
- **Nothing internal leaks:** only the schema's fields are accepted, URLs are public HTTPS hosts
  without credentials, queries or ports, and artifacts are never fetched or proxied.
- **Order:** stable and beta by SemVer (prereleases first), nightly by `released_at`. A version that
  would not be the channel's newest is 409 unless `allowDowngrade`.
- **Yank** keeps the row and its manifest; `latest` moves to the previous release on the next
  refresh (≤ 30 s, plus the 60 s HTTP max-age).

## Tests

`apps/api/test/releases/`: `releases.units.test.ts` (ordering, matching, manifest checks, signatures,
configuration, the CLI without a database), `releases.routes.test.ts` (publish → latest → yank,
400/404, ETag/304, cache headers, rate limit, contract, abuse, Postgres down, corrupt rows),
`releases.publish.test.ts` (downgrades, republish, superseding, the min-version key, Redis down),
`releases.perf.test.ts` (p95 in a child process via `releases-bench.ts`, and the script's dry run),
and on Postgres `releases.postgres.test.ts`.
