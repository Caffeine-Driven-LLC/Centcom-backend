# Feature flags (B083)

`GET /v1/flags` ([CT-API-FLAGS](../../../../../contracts/02-rest-api.md)): flags and remote config
evaluated for the caller, plus `isEnabled` for server code and the admin API B087's tooling calls.
The operator's guide is [docs/platform/feature-flags.md](../../../../../docs/platform/feature-flags.md).

## Pieces

| File            | What it does                                                                              |
| --------------- | ----------------------------------------------------------------------------------------- |
| `definition.ts` | `FlagDef` and its rules; `checkFlagDef` (admin input), `readStoredFlag` (lenient).        |
| `evaluate.ts`   | `evaluateFlags(ctx, defs)` and `isEnabledIn`: pure, deterministic, order-independent.     |
| `bucket.ts`     | `bucketOf(key, userId)`: SHA-256 of `key:userId`, 32 bits, modulo 10 000.                 |
| `version.ts`    | `parseClientVersion(User-Agent)` (CT-VER) and SemVer 2.0 order.                           |
| `cache.ts`      | `FlagCache`: per-process set, `flags:inv` pub/sub, 15 s poll, 5 min last-good window.     |
| `repository.ts` | `feature_flags` and the revision; limits checked under the revision's row lock.           |
| `service.ts`    | `FlagService` (answers, `isEnabled`), `FlagAdmin` (`setFlag`, `deleteFlag`, `listFlags`). |
| `actions.ts`    | `flag.set`, `flag.delete` on B036's catalogue, for this module's emitter only.            |
| `config.ts`     | `FLAGS_TTL_S`, `FLAGS_MAX_COUNT`, `FLAGS_MAX_VALUE_BYTES`.                                |

Route: `routes/flags.ts`. Migration: `20260102002500_feature_flags.sql`.

## Wiring

```ts
const repository = createFlagRepository(db);
const config = loadFlagsConfig();
const cache = new FlagCache({ repository, pubsub: redis.pubsub, logger, metrics });
await cache.start(); // and cache.stop() on close
const flags = new FlagService({ cache, config });
await app.register(flagRoutes, { flags, authenticate: (c) => tokens.authenticate(c) });

// Server code: flags.isEnabled('relay.compression', { userId, plan, now: new Date() })
// Admin tooling (B087):
const admin = new FlagAdmin({
  repository,
  emitter: createAuditEmitter({ db, actions: FLAG_AUDIT_ACTIONS, logger, metrics }),
  pubsub: redis.pubsub,
  config,
});
```

## Rules

- **Who sees what:** anonymous callers get `public` flags without percent, plan or workspace
  rules; a user token with `profile` gets its personal set; API keys and tokens without
  `profile` have no user and get the anonymous set. `server_only` flags are never sent.
- **Order:** kill switch (default for everyone), then an unknown stored rule (default), then
  the client version (out of range or unknown: the flag is hidden), plan, workspace, percentage.
  All rules must pass for the flag's value.
- **Caching:** the ETag is the revision plus a digest of the body; `If-None-Match` gives 304.
  Anonymous: `public, max-age=30`; authenticated: `private, max-age=<FLAGS_TTL_S>`; always
  `Vary: Authorization, User-Agent`.
- **Changes:** each moves the revision by exactly 1 and is audited (actor, key, revision, hash of
  the previous definition) in its transaction; then `flags:inv` tells every process.
- **Limits:** values ≤ `FLAGS_MAX_VALUE_BYTES`, ≤ `FLAGS_MAX_COUNT` flags, the client-visible
  flags within a 64 KiB answer; keys naming secrets and secret-like values are refused (422).
- **Never a gate for paid features:** entitlements and RBAC stay the only gates.

## Tests

`apps/api/test/flags/`: `flags.units.test.ts` (bucket vectors, the 30 % rollout, precedence,
visibility, versions, definitions, properties), `flags.routes.test.ts` (authz, ETag/304, headers,
version targeting, contract), `flags.cache.test.ts` (two instances over pub/sub, polling, Postgres
down, unknown rules), `flags.admin.test.ts` (revision, audit, limits), `flags.perf.test.ts` (500
flags, p95 in a child process, `flags-bench.ts`), and on Postgres `flags.postgres.test.ts`.
