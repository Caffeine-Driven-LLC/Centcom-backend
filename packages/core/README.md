# @centcom/core

Shared platform primitives for the backend services. Today this is configuration (lane B004),
logging (B005), errors (B006), Redis (B009, [`src/redis/README.md`](src/redis/README.md)), RBAC
(B021), rate limiting (B023), idempotency (B024), pagination (B025), email (B032) and deep links
(B033). The rest arrive with their lanes.

## Configuration (B004)

Every service reads its configuration once, at startup, through one typed loader. The keys, types
and defaults are listed in [`docs/config.md`](../../docs/config.md), which is generated from the
schemas.

### Public interface

| Export                                                           | What it is                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseConfig(env?, options?)`                                     | The base keys every service reads (`NODE_ENV`, `SERVICE_NAME`, `LOG_LEVEL`, `HOST`, `PORT`, `PUBLIC_API_URL`, `DATABASE_URL`, `REDIS_URL`, `TRUSTED_PROXY_HOPS`, `REQUEST_TIMEOUT_MS`, `ALLOW_INSECURE_BACKENDS`), returned as a deep-frozen `BaseConfig` |
| `defineConfig(schema, env?, options?)`                           | Parses the keys a `z.object()` schema declares; returns the deep-frozen result or throws `ConfigError`                                                                                                                                                    |
| `ConfigError`                                                    | Thrown for invalid configuration; `issues` lists `{key, problem}` for every problem, never a value                                                                                                                                                        |
| `Secret<T>`, `secretString(inner?)`                              | A value whose string, JSON and inspect forms are `[redacted]`; read it with `reveal()`                                                                                                                                                                    |
| `envInt({min, max})`, `envBool()`, `envUrl({protocols, plain?})` | Strict parsers for environment strings (no `1e3`, `0x10`, `yes` or relative URLs)                                                                                                                                                                         |
| `z`, `deepFreeze`, `DeepReadonly`, `Env`                         | zod (re-exported so lanes share one version) and helpers                                                                                                                                                                                                  |

### Rules

- **Read the environment only at the entrypoint.** Call `baseConfig()` (and your lane's own
  `defineConfig(...)`) in `apps/*/src/main.ts`, then pass the result on. Lint rejects reading the
  environment everywhere except the config loader (`packages/core/src/config/`), entrypoints and
  `tools/`. It catches `process.env`, `process['env']`, destructuring, `import { env }`, aliasing
  `process` to another name, `globalThis.process` / `global.process` and `process[key]`. It is a
  guardrail against mistakes, not a sandbox: deliberate indirection such as
  `Reflect.get(process, 'env')` is left to review.
- **Declare your own keys in your own module**, with `defineConfig`. Don't edit the base schema.
  Give every key `.meta({ description, example })` and add the schema to `SECTIONS` in
  `scripts/gen-config-docs.ts` so it appears in `docs/config.md` and `.env.example`.
- **Wrap secrets** with `secretString()`. Never put a value in a refinement message; messages are
  shown to operators. A message that does contain the value is scrubbed (values of 1-3 characters
  only as whole words), but don't rely on that.

### Behaviour

- Blank values count as unset. Missing required keys and invalid values are collected and thrown
  together, as one `ConfigError`.
- **`KEY_FILE` secrets.** Any key can be given as `KEY_FILE=<path>`:
  - the file wins over `KEY`. An empty file counts as unset; it does not fall back to `KEY`.
  - a UTF-8 byte-order mark and trailing newlines (`\n`, `\r\n`) are removed. Other whitespace is
    part of the value, exactly as for a `KEY` given directly.
  - the file is opened once (non-blocking, so a FIFO cannot hang startup). Its type, permission
    bits and at most 64 KiB + 1 bytes are read through that one handle, so the file cannot be
    swapped between check and read, and a file that misreports its size (procfs) is still capped.
  - a file that is missing, unreadable, not a regular file, or larger than 64 KiB is reported
    against `KEY_FILE`, without the path
  - in production, a world-readable secret file produces a warning. Group-readable files are
    deliberately silent: a service group is the usual way to share a secret, and warning on it
    would turn the warning into noise. Warnings go to `process.emitWarning` until B005 wires in
    the logger; pass `onWarning` to route them, and `readSecretFile` to replace file access in
    tests.
- **TLS in production.** `DATABASE_URL` needs exactly one `sslmode`, and it must be `require`,
  `verify-ca` or `verify-full`; a repeated `sslmode` is refused because drivers such as
  `pg-connection-string` use the last one. `REDIS_URL` needs `rediss://`.
  `ALLOW_INSECURE_BACKENDS=1` overrides both.
- **Strict `NODE_ENV`.** It is required, and an unknown value is an error; it is never mapped to
  `development`.

### Entrypoint pattern

Invalid configuration must stop the process before it opens a port. The logger's level and
service name come from the configuration, so warnings raised while loading it are collected and
logged once the logger exists:

```ts
// apps/<service>/src/main.ts
import { baseConfig, ConfigError, createLogger, type ConfigWarning } from '@centcom/core';

const warnings: ConfigWarning[] = [];
let config;
try {
  config = baseConfig(process.env, { onWarning: (w) => warnings.push(w) });
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message); // key names and problems only
    process.exit(1);
  }
  throw e;
}
const log = createLogger({
  level: config.logLevel,
  service: config.serviceName,
  env: config.nodeEnv,
  version: BUILD_VERSION,
});
for (const w of warnings) log.warn({ key: w.key, problem: w.problem }, 'config.warning');
```

### Docs and tests

```bash
pnpm --filter @centcom/core gen:config-docs   # rewrite docs/config.md and .env.example
pnpm test                                     # includes the freshness check for both files
```

`test/config/` covers:

- **`define.test.ts`:** aggregated errors, defaults, strict coercion, freezing
- **`secret.test.ts`:** redaction in every form
- **`file-secrets.test.ts`:** `KEY_FILE` handling
- **`base.test.ts`:** the base keys and the production rules
- **`docs-fresh.test.ts`:** the generated files

## Logging (B005)

Every service writes structured JSON logs, one line per event, through one logger created at the
entrypoint (see [Entrypoint pattern](#entrypoint-pattern)) and passed on. Each line goes through
`redact()` inside the logger before it is written, so no call site can log a token, key,
ciphertext, message body, path or branch name by accident (GUIDELINES §3.5), and there is no
unredacted logger to reach for. The request id, context and access log for the API live in
`@centcom/api` ([`apps/api/README.md`](../../apps/api/README.md)).

```json
{
  "level": "info",
  "time": "2026-10-06T18:07:41.123Z",
  "service": "api",
  "env": "production",
  "version": "1.4.2",
  "request_id": "req_01JA3Z8K2M5N7P9Q0R1S2T3V4W",
  "method": "GET",
  "route": "/v1/sessions/:id",
  "status": 200,
  "duration_ms": 4,
  "bytes": 40,
  "msg": "http.request"
}
```

### Public interface

| Export                                                   | What it is                                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createLogger({level, service, version, env?, ...})`     | The root logger. Options also take `destination` (default stdout), `metrics` (for `log_dropped_total`) and `now` (clock). Throws a `TypeError` for an unknown level                            |
| `Logger`                                                 | `fatal`/`error`/`warn`/`info`/`debug`/`trace(msg)` or `(fields, msg?)`, `child(bindings)`, `level`, `isLevelEnabled(level)`                                                                    |
| `redact(value)`                                          | A deep copy of any value that is safe to log; pure, never throws, never mutates its input                                                                                                      |
| `getRequestContext()`, `runWithContext(ctx, fn)`         | The current request's ids (`requestId`, and `userId`, `sessionId` once auth sets them), kept in AsyncLocalStorage; the logger adds them to every line as `request_id`, `user_id`, `session_id` |
| `Metrics`, `Counter`, `Histogram`, `noopMetrics`         | `counter(name, labels?).inc(n?)` and `histogram(name, buckets).observe(value, labels?)`; the no-op default stands in until the observability lane (B093) provides an exporter                  |
| `MAX_LOG_STRING_LENGTH`, `MAX_LOG_DEPTH`, ... `REDACTED` | The limits below and the placeholders `[redacted]`, `[unserialisable]` (`UNSERIALISABLE`), `[truncated]` (`TRUNCATED`)                                                                         |

### What redaction does

- **Deny-listed keys** lose their value, at any depth: `authorization`, `cookie`, `set-cookie`,
  `token`, `refresh_token`, `access_token`, `secret`, `password`, `api_key`, `ct`, `sig`, `text`,
  `p`, `body`, `path`, `branch`, `cwd`, `device_code`, `user_code`, `code_verifier`, `code`,
  `ticket` and `sec-websocket-protocol`. Keys are compared ignoring case, `-` and `_`
  (`refreshToken`, `API-KEY`). Compound names are caught too: keys ending in `token`, `apikey`,
  `privatekey`, `authorization`, `authcode`, `cookie(s)`, `credential(s)`, `signature`, `ticket`,
  `path(s)` or `branch(es)` (`id_token`, `x-api-key`, `file_path`), and keys containing `secret`,
  `password` or `passwd`. Short words (`p`, `ct`, `code`, `text`, `body`) match exactly only, so
  `status_code`, `tokens_in` and `context` stay readable.
- **Secrets inside strings** are replaced wherever they appear, in values, keys and messages:
  CT-AUTH API keys (`cen_live_…`, `cen_test_…`), JWTs and JWEs (`eyJ…` with two or more dots, with
  any text glued to them) and `Bearer` credentials (the scheme word stays).
- **Limits:** strings (and keys) are cut at 2 000 characters, ending in `…`; a credential that
  crosses the cut is dropped whole, never left half there. Objects more than 8 levels below the
  logged value become `[truncated]`, and so does everything after 100 000 copied entries.
- **Other values:** cycles and objects whose properties throw (getters, revoked proxies, failing
  `toJSON`) become `[unserialisable]`; `Secret`s and binary data (`Buffer`, typed arrays) become
  `[redacted]`; errors keep `type`, `message`, `stack`, their `code`, `cause` and other
  properties (redacted like everything else); URLs keep only origin and path; dates become ISO
  strings; bigints become strings.
- Redaction runs only for lines at an enabled level. A 1 MB object takes about 5 ms on a
  developer machine (the card's budget is 50 ms).

### Rules for callers

- **Put data in fields, not in the message.** Messages are redacted too, but fields are
  searchable: `log.info({ rows }, 'query.done')`.
- **Errors go under `err`:** `log.error({ err }, 'publish.failed')`.
- **Don't pass the keys the logger owns:** `level`, `time`, `msg`, `service`, `env`, `version`,
  `request_id`, `session_id`, `user_id`.
- **Ids only in the context.** A `userId` or `sessionId` that is not a CT-IDS id is logged as
  `[redacted]`.
- **Metric labels come from small fixed sets:** route templates, methods, status classes. Never
  an id, a raw path or any content.

### Failure modes

- **The destination fails** (an error, an ended stream, a write that throws): the line is
  dropped and counted in `log_dropped_total`; nothing is thrown into the caller. After a stream
  reports an error, every later line is dropped too.
- **The destination is slow:** at most 4 MiB (`MAX_LOG_BUFFER_BYTES`) of lines wait for it; later
  lines are dropped and counted. The default stdout writer is asynchronous and flushes on exit.
- **An unknown level** throws a `TypeError` at startup.

### Tests

`test/log/` covers:

- **`redact.test.ts`:** the deny list and its variants, the value patterns, the cap, cycles, the
  depth cap, exotic objects and the 1 MB budget (timed in a separate process by
  `redact-bench.ts`, away from coverage instrumentation)
- **`fuzz.test.ts`:** random and hostile values never make `redact()` throw; planted secrets never
  reach the output; the output is stable and serialisable
- **`logger.test.ts`:** the line format, redaction of fields, messages, errors and child
  bindings, the context ids, levels, and every destination failure
- **`context.test.ts`:** the context across `await`, timers and concurrent requests
- **`metrics.test.ts`:** the no-op default

Tests capture lines by passing a `Writable` as `destination`, fix the clock with `now`, and count
metrics with a recording `Metrics`.

## Errors (B006)

Code throws typed errors that carry a CT-ERR registry code, never strings or bare `Error`s
(GUIDELINES §3.4). `toProblem` turns anything thrown into the RFC 9457 problem body CT-ERR defines
([`contracts/00-foundations.md`](../../contracts/00-foundations.md)). The API's error handler
plugin sends it as `application/problem+json`
([`apps/api/README.md`](../../apps/api/README.md#error-handler-plugin-b006)); the relay sends the
same body in its `sys.error` frames.

```ts
import { validate } from '@centcom/contracts';
import { forbidden, tooManyRequests, validationFailed } from '@centcom/core';

const batch = validate('api/UsageBatch', request.body);
if (!batch.ok) throw validationFailed(batch.errors); // 422, errors[0].pointer "/events/3/qty"
if (!member) throw forbidden(); // 403
if (!allowed) throw tooManyRequests(30); // 429, retry_after_s 30
```

### Public interface

| Export                                                                                                | What it is                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new AppError(code, {detail?, errors?, retryAfterS?, status?, cause?})`                               | An error with a registry code; `code`, `status`, `detail`, `errors`, `retryAfterS` are read-only. The code is typed `ErrorCode`, so only registry codes compile |
| `badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable(detail?, {cause?})` | 400 `invalid_request`, 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 422 `validation_failed`                                            |
| `tooManyRequests(retryAfterS, detail?)`, `unavailable(retryAfterS?, detail?)`                         | 429 `rate_limited` and 503 `service_unavailable`, with the retry hint                                                                                           |
| `validationFailed(errors, detail?)`                                                                   | 422 `validation_failed` with `errors[]`; takes the issues a `@centcom/contracts` validator returns as they are                                                  |
| `toProblem(err, {requestId, instance?})`                                                              | The problem body for anything thrown. Pure: logs nothing, changes nothing                                                                                       |
| `isRetryable(status, method, hasIdempotencyKey)`                                                      | The CT-ERR retry table (below)                                                                                                                                  |
| `ERROR_CODES`, `isErrorCode`, `errorEntry(code)`, `codeForStatus(status)`, `isErrorStatus`            | The registry, from `contracts/errors.json` through B003's generated module: status, area, default title, retryability and `type` per code                       |
| `ErrorCode`, `Problem`, `FieldError`                                                                  | Types generated from the contracts (never hand-written, GUIDELINES §2.2)                                                                                        |
| `ERROR_DETAILS`                                                                                       | The error layer's own user-facing details (one message table)                                                                                                   |
| `fallbackProblemBody(requestId)`, `PROBLEM_CONTENT_TYPE`, `DEFAULT_RETRY_AFTER_S`, ...                | The static 500 body for when building a problem fails, the media type, and the limits below                                                                     |

### What a problem holds

- **`type`, `title`, `status`, `code`** come from the registry, so `code` is always a registry code.
  An AppError whose code is not in the registry (only possible through a cast) goes out as the
  generic code of its status class, `invalid_request` or `internal_error` (CT-ERR rule 7).
- **`detail`** only when the error has one. It passes through the log redaction patterns (API
  keys, JWTs, `Bearer` credentials become `[redacted]`) and is cut at 2 000 characters, as a safety
  net.
- **`instance`** when the caller knows the route: the route template (`/v1/sessions/:id`), never
  the raw URL.
- **`request_id`**, always.
- **`retry_after_s`** exactly for 429, 503 and retryable codes (CT-ERR rule 6), which includes
  `internal_error`, `bad_gateway`, `timeout`, `session_paused`, `authorization_pending` and
  `slow_down`: the error's `retryAfterS` rounded up to whole seconds, else 1 s
  (`DEFAULT_RETRY_AFTER_S`), at most 366 days (`MAX_RETRY_AFTER_S`). Other codes never carry it,
  even if the error has a hint.
- **`errors[]`**, at most 100 entries (`MAX_FIELD_ERRORS`), each `{pointer, code, detail?}`.
- **Anything that is not an AppError** (a `TypeError`, a string, a library error, an object that
  merely looks like an AppError) becomes a 500 `internal_error` with a generic detail. Its message,
  stack and properties never reach the body: log the error instead.

### Rules for callers

- **Throw AppErrors**, from the helpers or `new AppError(code)`, and pick the most specific code
  (`role_insufficient` rather than `forbidden`).
- **`detail` is shown to users** (CT-ERR rule 2): English from your message table, never secrets,
  other users' data, internal paths, SQL or values copied from the request. The scrubbing above is
  a safety net, not a licence.
- **Authentication failures look alike.** Throw `unauthorized()` with the same detail (or none)
  whatever the cause, so the body never tells whether a user exists.
- **`status` is for statuses without a code of their own** (405, 414), sent with that class's
  generic code. An override from another class (a 4xx code as a 500) is ignored.

### Retry table

`isRetryable(status, method, hasIdempotencyKey)` answers whether a failed request may be sent
again; clients and the server obey the same table:

| Status                            | Retried                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| 400, 401, 403, 404, 409, 410, 422 | Never: fix the request (a 401 means refresh the token once, then log in)        |
| 408, 425, 429                     | Yes, honouring `Retry-After`                                                    |
| 500, 502, 503, 504                | Idempotent requests only: GET, HEAD, OPTIONS, PUT, DELETE, or a POST with a key |
| Anything else                     | Never                                                                           |

A POST without an `Idempotency-Key` is never retried (CT-PAGE defines the key for POST only, so a
PATCH is never idempotent).

### Tests

`test/errors/` covers:

- **`problem.test.ts`:** the shape for every registry code (table-driven, validated against
  `problem.schema.json`), the `quota.json` and `validation.json` fixtures reproduced byte for byte,
  rules 6 and 7, unknown errors (property-tested: their message never reaches the body), every
  output valid for any code and options (property), detail scrubbing and the caps
- **`app-error.test.ts`:** every helper's code and status, copied and frozen field errors, the
  status override and stray codes
- **`registry.test.ts`:** the registry against `contracts/errors.json`, and `codeForStatus`
- **`retry-table.test.ts`:** the CT-ERR retry table as a matrix of statuses, methods and keys

## RBAC (B021)

One engine answers every authorisation question from the CT-RBAC matrix (`src/rbac/`). REST
routes (through `apps/api/src/plugins/rbac.ts`) and the relay call it; no other code compares role
strings.

```ts
import { cachedMembershipReader, createAuthorizer, subscribeInvalidations } from '@centcom/core';
import { createMembershipRepo } from '@centcom/db';

const memberships = cachedMembershipReader(createMembershipRepo(db)); // roles reused at most 2 s
await subscribeInvalidations(redis.pubsub, memberships); // rbac:invalidate drops them at once
const authorizer = createAuthorizer({ memberships, audit, logger, metrics });

await authorizer.authorize(actor, 'workspace.update', { workspaceId }); // or throws 403 forbidden
```

### Public interface

| Export                                                                                        | What it is                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Action`, `ACTIONS`, `WORKSPACE_ACTIONS`, `SESSION_ACTIONS`                                   | The catalogue: 16 workspace actions (`workspace.read` … `workspace.delete`) and 11 session actions (`session.message.send` … `session.history.read`) |
| `MATRIX`                                                                                      | One rule per action, citing its CT-RBAC row: the roles allowed and under which condition, whether a denial is audited, the API-key scope             |
| `can(actor, action, resource, {workspaceRole?, sessionRole?, delegatedApprover?})`            | The pure decision: `{allow: true, limited?}` or `{allow: false, reason}`; never throws                                                               |
| `createAuthorizer({memberships, audit, logger?, metrics?})`                                   | `authorize` (loads roles, decides, audits privileged denials, throws 403) and `decide`                                                               |
| `MembershipReader`, `cachedMembershipReader`, `subscribeInvalidations`, `publishInvalidation` | Role lookups (Postgres: `createMembershipRepo` in `@centcom/db`), the 2 s cache and the `rbac:invalidate` channel                                    |
| `SCOPES`, `hasScope`, `hasScopes`                                                             | CT-AUTH scopes; exact names only                                                                                                                     |
| `defaultSessionRole(role)`                                                                    | owner, admin, member: `editor`; guest (and billing): `viewer`                                                                                        |

### Rules

- **Default deny.** Each of these is denied:
  - an unknown action, actor or role, or a missing role;
  - a condition that is not met, or cannot be checked because the resource lacks the fact;
  - an API key on any session action, on another workspace, or without the action's scope.
- **Roles come from membership state only** (rule 1). The resource carries ids and server-side
  facts (the target member's role, an invitation, the session mode); an actor's claimed role
  counts for nothing.
- **Conditions** (resolved details of v1.1.0):
  - **Guests:** a guest's read is `limited`; a guest joins as viewer only when invited.
  - **Owner:** assigns any role but a second owner, removes anyone but themselves, and is the
    only one who grants or removes `admin`.
  - **Admin:** moves members between `member`, `billing` and `guest` only.
  - **Members:** manage their own API keys only; anyone but the owner may leave
    (CT-API-WORKSPACES "self").
  - **Sessions:** spawning a branch agent needs a branch-mode session, and delegated approvers
    may approve tool calls.
- **Denials:** `authorize` throws 403 `forbidden` with one fixed detail.
  - Denials of privileged actions (all but `workspace.read`, `session.history.read`,
    `session.presence`, `session.react` and `session.comment`) write one `rbac.denied` audit
    record with actor, action and resource ids (rule 6).
  - A failing audit sink does not turn a denial into an allow (counted in
    `rbac_audit_failures_total`, logged as `rbac.audit_failed`).
- **Membership unreadable:** a 503, never an allow. Answers are reused at most 2 s (rule 2) and
  dropped at once on `rbac:invalidate` (`{userId?, workspaceId?, sessionId?}`); code that
  changes a membership publishes one.

### Tests

`test/rbac/`:

- **`matrix.test.ts`:** reads both tables from `contracts/01-auth-rbac.md` and checks every cell,
  conditional cells with the condition met and not met; an unknown cell text fails.
- **`coverage.test.ts`:** a rule for every action, every rule citing a real row, every row covered.
- **`scopes.test.ts`:** scope subsets, and API keys.
- **`can.fuzz.test.ts`:** default deny, and 1 000 seeded fuzzed combinations that neither throw
  nor allow.
- **`membership-cache.test.ts`:** 2 s, invalidation through B009's pub/sub, failures uncached.
- **`authorize.test.ts`:** audit records, 503 on unreadable membership, audit sink down.

## Rate limiting (B023)

Every API request counts against one CT-PAGE bucket (`src/ratelimit/`). The policy lives here; the
Fastify plugin that applies it is `apps/api/src/plugins/rate-limit.ts`.

```ts
import { baseConfig, createRateLimiter, rateLimitConfig, resolveClientIp } from '@centcom/core';

const config = rateLimitConfig(baseConfig()); // RATELIMIT_* and TRUSTED_PROXY_HOPS
const limiter = createRateLimiter({
  store: redis.rateLimit,
  kv: redis.kv,
  config,
  logger,
  metrics,
});
const ip = resolveClientIp(request, config.trustedHops);
const decision = await limiter.check({ bucket: 'default', principal, ip }); // allowed, limit, ...
```

### Public interface

| Export                                                                  | What it is                                                                                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultBuckets`, `rateLimitConfig(base, env?)`, `rateLimitEnvSchema`   | The five buckets (per 60 s: anonymous 30, user 600, API key 1200, auth 20, usage 60) and their `RATELIMIT_*` overrides ([docs/config.md](../../docs/config.md#rate-limits)) |
| `bucketKey(route, principal, ip)`                                       | Where a request counts (see Rules)                                                                                                                                          |
| `resolveClientIp(req, trustedHops)`, `ipBucket(ip)`, `normalizeIp(raw)` | The client address behind trusted proxies, and the bucket it counts in                                                                                                      |
| `createRateLimiter({store, kv?, config, clock?, logger?, metrics?})`    | `check(request)`: `{allowed, bucket, limit, remaining, resetS, retryAfterS?, degraded, blocked}`; `maxCost(bucket)`                                                         |

### Rules

- **Keys:** never the URL.
  - Users count by `usr_` id from any address, API keys by `key_` id.
  - The `auth` bucket counts by address, whoever calls.
  - `usage` counts by `dev_` id, else by the user or key, else by address.
  - Everyone else counts by address; an IPv6 address by its /64.
  - A malformed id throws: it is a bug in whoever built the principal.
- **Client address:**
  - with `TRUSTED_PROXY_HOPS=0`, the socket address;
  - with N, the N-th `X-Forwarded-For` entry from the right (the leftmost when there are fewer).
    Entries further left are never read, and a malformed entry ends the walk;
  - `Fly-Client-IP` stands in when `X-Forwarded-For` has nothing usable;
  - with no address at all, the shared `unknown` address.
- **Store failure:** while B009's store throws, a per-process limiter decides: general buckets at
  twice their limit, the auth bucket at its own. Limiting never stops.
  - Each failure counts in `ratelimit_store_errors_total`, and `ratelimit.store_unavailable` is
    logged at most once a minute.
  - The store is tried again after 5 s; `ratelimit.store_recovered` is logged when it answers.
- **Abuse block:** an address's 5th overrun of the auth bucket within 10 minutes blocks it for 15
  minutes.
  - The block covers every bucket counted by address: anonymous, auth, and usage without an id.
  - Signed-in callers from that address are counted by who they are, and are not blocked.
  - The block lives in the key-value store, so every instance honours it.
  - Each block counts in `ratelimit_blocks_total` and is logged as `ratelimit.ip_blocked` (warn,
    with the address bucket).
- **Windows:** sliding, as B009's store computes them.
- **Metrics:** `ratelimit_denied_total{bucket}` as well; no label holds an address or an id.

### Tests

`test/ratelimit/`:

- **`buckets.test.ts`:** the five defaults, every key, the env overrides and the config checks.
- **`client-ip.test.ts`:** proxy chains, spoofed `X-Forwarded-For`, `Fly-Client-IP` and IPv6 /64,
  with property tests.
- **`fallback.test.ts`:** store errors, the doubled limits and the strict auth bucket, the warning
  and recovery.
- **`abuse-block.test.ts`:** the block, its expiry, and sharing between instances.
- **`concurrency.test.ts`:** 100 parallel requests never exceed the limit, on the fallback too.
- **Redis:** the last two also run against Redis 7 in CI.

## Idempotency (B024)

What CT-PAGE's `Idempotency-Key` keeps, and how (`src/idempotency/`). The Fastify plugin that
applies it is `apps/api/src/plugins/idempotency.ts`.

```ts
import {
  createIdempotencyStore,
  fingerprintRequest,
  idempotencyConfig,
  storeKeyFor,
} from '@centcom/core';

const store = createIdempotencyStore({ kv: redis.kv, ...idempotencyConfig(), logger, metrics });
const key = storeKeyFor(principalId, 'POST', '/v1/invites', idempotencyKey);
const claim = await store.claim(key, fingerprintRequest('POST', '/v1/invites', params, body));
// claimed: run, then store.complete(key, fp, response) | replay | conflict | in_flight
```

### Public interface

| Export                                                                                  | What it is                                                                                                                   |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `parseIdempotencyKey(header)`                                                           | The key (one ULID or UUID, at most 64 characters), or a 422 pointing at `/headers/idempotency-key`                           |
| `storeKeyFor(principal, method, route, key)`                                            | `idem:<sha256>` of the scope: one caller's key never meets another's                                                         |
| `fingerprintRequest(method, route, params, body)`, `canonicalJson`, `fingerprintsEqual` | `sha256:<hex>` of the request (keys sorted at every depth), compared in constant time                                        |
| `createIdempotencyStore({kv, clock?, encryptionKey?, ...})`                             | `claim`, `complete` and `release` over B009's KeyValue                                                                       |
| `sealBody`, `openBody`, `idempotencyConfig(env?)`                                       | AES-256-GCM for sensitive bodies, keyed by `IDEMPOTENCY_ENCRYPTION_KEY` ([docs/config.md](../../docs/config.md#idempotency)) |

### Rules

- **Records:** one store key per (principal, method, route template, key).
  - Claiming writes an in-flight lock atomically (`setIfAbsent`, 30 s), which outlives a crashed
    process by at most that long.
  - Completing replaces the lock with the response for 24 hours: the status, the body, and only
    `content-type`, `content-language`, `location`, `etag` and `last-modified`. `Set-Cookie`, auth
    and every other header are never kept.
  - 5xx responses, bodies over the route's limit (256 KiB by default, 1 MiB at most) and records
    over B009's value limit are not kept: the lock is released, so a retry runs again.
- **Claims:**
  - the same fingerprint replays the response;
  - a different fingerprint is a conflict;
  - the same fingerprint while the first request runs waits up to 10 s (polling) for its result,
    then is `in_flight`;
  - a released key is claimed again by the waiting duplicate.
- **Sensitive bodies:** sealed with AES-256-GCM. Each record gets a fresh IV, and its store key is
  the associated data, so a sealed body opens only where it was stored.
- **Unreadable records:** a record that does not parse or verify (tampered, sealed under another
  key) is never replayed. It is deleted, counted in `idempotency_invalid_records_total` and logged
  as `idempotency.invalid_record`; the request runs as new, as after an evicted key.

### Tests

`test/idempotency/`:

- **`fingerprint.test.ts`:** canonical JSON and key-order independence, as property tests.
- **`crypto.test.ts`:** round trips, tamper detection and the env key.
- **`store.test.ts`:** claims, replays, conflicts, the in-flight wait, what is never kept, sealed
  bodies, unreadable records and the header parser.
- **`expiry.test.ts`:** 24 h and 30 s on a fake clock.
- **`concurrency.test.ts`:** 20 parallel claims leave one runner.
- **`principal-isolation.test.ts`:** store keys, including a property test.
- **Redis:** `store.test.ts` and `concurrency.test.ts` also run against Redis 7 in CI.

## Pagination (B025)

Every list endpoint pages with CT-PAGE cursors through one library (`src/pagination/`). The
Fastify side is `reply.page` (`apps/api/src/plugins/pagination.ts`).

```ts
import {
  defineFilters,
  enumFilter,
  idFilter,
  paginate,
  paginationConfig,
  parsePageQuery,
} from '@centcom/core';

const { signingKeys } = paginationConfig(); // CURSOR_SIGNING_KEYS; required
const filters = defineFilters({
  workspace: idFilter('wsp'),
  state: enumFilter(['active', 'ended']),
});
const spec = { sorts: { '-created_at': { column: 'created_at', direction: 'desc' } } } as const;

const page = parsePageQuery(request.query, { sorts: ['-created_at'], defaultSort: '-created_at' });
const f = filters.parse(request.query);
let query = db.selectFrom('sessions').selectAll();
if (f.state !== undefined) query = query.where('state', '=', f.state);
const result = await paginate(query, spec, {
  ...page,
  filterHash: filters.hash(f),
  keys: signingKeys,
  now: Date.now(),
});
return reply.page(result.data, result.next_cursor);
```

### Public interface

| Export                                                                                               | What it is                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `parsePageQuery(q, {sorts, defaultSort, maxLimit?})`                                                 | `limit` (1 to 200, default 50), `cursor` and an allowed `sort`; offsets, pages and `skip` are refused |
| `encodeCursor`, `decodeCursor`, `paginationConfig(env?)`                                             | Signed cursors and `CURSOR_SIGNING_KEYS` ([docs/config.md](../../docs/config.md#pagination))          |
| `defineFilters({...})` with `stringFilter`, `enumFilter`, `idFilter`, `booleanFilter`, `rangeFilter` | An endpoint's filters: `parse(query)` and `hash(filters)`                                             |
| `paginate(qb, spec, params)`, `paginateArray(items, spec, params)`, `page(data, next)`               | Keyset pages from a Kysely query or a list in memory, and the CT-PAGE shape                           |

### Rules

- **Parameters:**
  - `limit` must be 1 to 200 (an endpoint may lower it, never raise it); a bad limit or sort is a
    422 pointing at `/limit` or `/sort`.
  - `offset`, `page` and `skip` are refused with 422 rather than ignored.
  - Undeclared filter parameters are ignored.
- **Cursors** are `<key id>.<payload>.<signature>`.
  - The payload is base64url JSON `{v, k, f, s, exp}`: the last row's keyset values, the filter
    hash, the sort, and the expiry 24 hours on.
  - The signature is HMAC-SHA256, compared in constant time and as text, so no two spellings
    verify.
  - The newest key signs and every configured key verifies.
  - Any bad cursor (malformed, unknown key, bad signature, expired, other filters or sort) is a
    400 `cursor_invalid` with `errors[0].pointer` `/cursor` and code `invalid`, `expired` or
    `mismatch`. It is never a 500.
- **Keysets:** `paginate` orders by `(sort column, id)`, both in the sort's direction, and
  fetches `limit + 1` rows.
  - It continues with `(column, id) > ($1, $2)` (`<` descending), so values are always
    parameters, and an index on `(column, id)` serves it.
  - It clears any order, limit or offset the query had.
  - Keyset values travel as Postgres prints them (`::text`), so a timestamp keeps its
    microseconds.
  - Sort columns and the id must be NOT NULL.
- **No counts:** totals are never computed or returned.

### Tests

`test/pagination/`:

- **`cursor.test.ts`:** the codec, binding, expiry, every one-character change, forgery, rotation
  and the config.
- **`fuzz.test.ts`:** arbitrary and mutated cursors throw only `cursor_invalid`.
- **`query.test.ts`:** limits, sorts and refused offsets.
- **`filters.test.ts`:** every filter type, and hash stability.
- **`keyset.test.ts`:** the SQL `paginate` builds, page assembly, and `paginateArray`.
- **Postgres:** the same guarantees against Postgres are in
  `apps/api/test/pagination.test.ts` (CI).

## Email (B032)

Transactional email (`src/email/`): typed templates with escaping, input rules, providers, and the
service that queues emails for the `email-send` job in `apps/worker`
([README](../../apps/worker/README.md)).

```ts
import { Queue } from 'bullmq';
import { createEmailService, EMAIL_QUEUE, emailConfig } from '@centcom/core';

const config = emailConfig(); // EMAIL_PROVIDER, EMAIL_FROM, POSTMARK_SERVER_TOKEN, EMAIL_TIMEOUT_MS
const email = createEmailService({
  queue: new Queue(EMAIL_QUEUE, { connection, prefix: 'ct:production:bull' }),
  rateLimit: redis.rateLimit,
  kv: redis.kv,
  from: config.from,
  logger,
  metrics,
});
await email.send(
  'workspace_invite',
  to,
  { inviterName, workspaceName, url, expiresAt },
  { idempotencyKey },
);
```

### Public interface

| Export                                                                                  | What it is                                                                                                                  |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `createEmailService({queue, rateLimit, kv, from, templates?, ...})`                     | `send(id, to, params, {idempotencyKey?})` queues; `render(id, params)` previews                                             |
| `TemplateParams`, `TemplateId`, `createTemplateRegistry()`, `markup`, `escapeHtml`      | Templates: `workspace_invite`, `account_deletion_scheduled`, `export_ready`; later lanes add theirs with `registerTemplate` |
| `PostmarkProvider`, `MemoryEmailProvider`, `ConsoleEmailProvider`, `EmailProviderError` | Providers: Postmark over `fetch`, in memory (`sent`), and logs only                                                         |
| `emailConfig(env?)`, `createEmailProvider(config, logger)`                              | Configuration ([docs/config.md](../../docs/config.md#email))                                                                |

### Rules

- **Escaping:** every parameter is escaped by `markup` (named so, not `html`, because Prettier
  reformats `html` template literals). Callers cannot pass HTML: parameters are checked by kind.
  - Text is 1 to 200 characters without line breaks or control characters.
  - Links must be https (http only for localhost), have no credentials, and are used exactly as
    given (no tracking, no redirect).
  - Dates are formatted like `7 October 2026` (UTC). The plain-text part is always there.
- **Headers:** a CR or LF in the recipient, the sender, the subject or any name is refused (422)
  before anything is queued.
  - The recipient is lower-cased and at most 254 characters.
  - Subjects are cut to 150 characters.
- **Limits:** 5 emails of one template to one address per hour; the 6th is a 429 with
  `retry_after_s`.
- **Queue:** every job carries its BullMQ options (`emailJobOptions()`: 5 attempts, the `email`
  backoff, removal rules), so any BullMQ queue named `email-send` works; the worker's
  `createEmailQueue` is one.
- **Idempotency:** the same idempotency key, template and recipient within 24 hours queue nothing
  more.
  - The job id is derived from the key, so a concurrent duplicate is dropped by BullMQ.
  - If the key cannot be remembered after queueing, the send still succeeds
    (`email_idempotency_unrecorded_total`).
- **Failures:**
  - An unknown template throws at `send`, never at delivery.
  - Redis or the queue failing is a 503 with `retry_after_s: 1`; nothing is ever sent inline.
- **Logs and metrics:** only the template and job id are logged (`email.queued`), never the
  recipient, a parameter, a link or the body. Metrics: `email_queued_total{template}` and
  `email_rate_limited_total{template}`.
- **Postmark:** `POST /email` with the server token in its header, `TrackOpens: false` and
  `TrackLinks: None`.
  - 429 and 5xx are retryable (Retry-After honoured), as are timeouts and network errors; other
    4xx are permanent.
  - Errors carry the status only: never the token, the recipient or Postmark's own text.

### Tests

`test/email/`:

- **`render.test.ts`:** golden HTML and text per template (`golden/*.golden`), escaping with a
  property test, links, the subject limit, and the registry.
- **`validation.test.ts`:** header injection and address limits.
- **`postmark.test.ts`:** a local HTTP stub answering 200, 4xx, 429 and 5xx, a timeout, a closed
  port, and malformed replies.
- **`service.test.ts`:** queueing, the per-recipient limit, idempotency keys, Redis and queue
  failures, and logging.
- **`config.test.ts`:** the configuration, and the memory and console providers.

## Deep links (B033)

Every Centcom link in CT-DEEPLINK's table (`src/deeplink/`): builders for the web and app form,
a strict parser, link tokens and their lifetimes, and the fragment guard. The Fastify plugin that
puts the invite and notification builders on the API is `deeplinksPlugin` in
`apps/api/src/modules/deeplinks/` ([README](../../apps/api/README.md#deep-links-b033)).

```ts
import { buildJoinUrl, deeplinkConfig, generateLinkToken, parseDeepLink } from '@centcom/core';

const { webBase } = deeplinkConfig(); // WEB_BASE_URL, https://centcom.dev by default
buildJoinUrl(generateLinkToken(), webBase); // { web: 'https://centcom.dev/j/…', app: 'centcom://join/…' }
parseDeepLink('centcom://session/ses_…?focus=approval', { webBase });
// { ok: true, kind: 'session', form: 'app', sessionId: 'ses_…', focus: 'approval' }, or { ok: false }
```

| Purpose                 | Web URL             | App URL                                  | Builder                          |
| ----------------------- | ------------------- | ---------------------------------------- | -------------------------------- |
| Join a session          | `<base>/j/<token>`  | `centcom://join/<token>`                 | `buildJoinUrl(token, base?)`     |
| Open a session          | `<base>/s/<ses_id>` | `centcom://session/<ses_id>[?focus=…]`   | `buildSessionUrl(id, focus?, …)` |
| Auth callback (desktop) | none                | `centcom://auth/callback?code=…&state=…` | `buildAuthCallbackUrl(code, st)` |
| Upgrade / billing       | `<base>/billing`    | `centcom://billing`                      | `buildBillingUrl(base?)`         |
| Accept workspace invite | `<base>/i/<token>`  | `centcom://invite/<token>`               | `buildInviteUrl(token, base?)`   |
| Join as viewer guest    | `<base>/g/<token>`  | `centcom://share/<token>`                | `buildShareUrl(token, base?)`    |

### Public interface

| Export                                                            | What it is                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `build*Url(…)`, `LinkPair`, `SessionFocus`                        | The builders above; each throws a TypeError for input off the table              |
| `parseDeepLink(input, {webBase?})`, `DeepLink`, `NotADeepLink`    | `{ok: true, kind, form, …}` or `{ok: false}`; never throws on its input          |
| `generateLinkToken(rng?)`, `LINK_TTL`, `RandomSource`             | 160-bit tokens from the CSPRNG; invites last 7 days, share links 24 h at most    |
| `assertServerUrl(url)`, `withKeyFragment(url, key)`               | The fragment guard; `#k=` for tests that play a client (never in server code)    |
| `deeplinkConfig(env?)`, `webOrigin(base)`, `DEFAULT_WEB_BASE_URL` | Configuration ([docs/config.md](../../docs/config.md#deep-links)) and its checks |

### Rules

- **No key material:** a URL the server builds never has a fragment (`assertServerUrl` runs on
  every one, so a token with `#` throws), and the parser refuses a fragment or a `k` parameter.
  `withKeyFragment` exists for tests; a test fails if any server source calls it or writes `#k=`.
- **Strict parsing:** the match is literal (the configured origin exactly, lower case, no port or
  credentials unless the origin has them; `centcom://`; the table's paths with no trailing `/`),
  not a URL parser's normalised reading, so `https:\\centcom.dev\j\…` or `/%6A/` is refused.
  - Tokens are 27 base64url characters; session ids pass CT-IDS (`ses_` and 26 Crockford base32).
  - Unknown query parameters are ignored. `focus` (`approval` or `queue`), `code` and `state` (1
    to 512 unreserved characters) must appear once with a valid value.
  - Inputs over 2 048 characters are refused before any matching.
- **Neutral refusals:** every refusal is the same frozen `{ ok: false }`: no reason, no echo.
- **Builders:** take tokens of 1 to 64 base64url characters (`buildJoinUrl('T')` works; the
  server's tokens are 27), a `ses_` id, and add only the parameters the table names: no
  `return_to` or other redirect parameter.
- **Origin:** `WEB_BASE_URL` must be https with nothing but an origin; anything else stops the
  process at boot (`ConfigError`).
- **Tokens:** 20 bytes from `node:crypto`'s `randomBytes`, never derived from ids or time. A
  source that throws or gives the wrong number of bytes throws; there is no fallback. No
  `Math.random` anywhere in the deep-link code (a test checks).

### Tests

`test/deeplink/`:

- **`deeplink.build.test.ts`:** golden URLs for every row of the table, read from
  `contracts/08-integrations.md` (a new row fails the test until it is built), `WEB_BASE_URL`,
  refusals, no `#` in any built URL, the fragment helpers, and the server-source check.
- **`deeplink.parse.test.ts`:** the accept and refuse matrix, unknown parameters, neutral results.
- **`deeplink.fuzz.test.ts`:** 10 000 generated strings (arbitrary, edited links, assembled near
  misses) never throw, and are accepted only when an independent oracle of the table accepts them.
- **`deeplink.token.test.ts`:** length and alphabet, 1 000 000 draws without a collision, the
  CSPRNG, source failures, `LINK_TTL`, and no `Math.random`.
