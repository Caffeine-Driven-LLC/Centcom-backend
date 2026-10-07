# @centcom/api

The Fastify REST API (`/v1/*`, CT-API). It is assembled lane by lane; today it holds the request
context plugin (B005), the error handler plugin (B006) and the users module (B013). Logging and the error types themselves
live in `@centcom/core` ([`packages/core/README.md`](../../packages/core/README.md#logging-b005),
[errors](../../packages/core/README.md#errors-b006)).

```ts
import { fastify } from 'fastify';
import { errorHandlerPlugin, frameworkErrorHandler } from './plugins/error-handler.js';
import { requestContextPlugin } from './plugins/request-context.js';

const app = fastify({ logger: false, frameworkErrors: frameworkErrorHandler({ logger: log }) });
await app.register(requestContextPlugin, { logger: log, metrics }); // first
await app.register(errorHandlerPlugin, { logger: log }); // second, before any route
```

## Request context plugin (B005)

`src/plugins/request-context.ts` gives every request a CT-IDS `req_` id, runs the request inside
the logging context, and writes one access-log line per request.

```ts
import { fastify } from 'fastify';
import { requestContextPlugin } from './plugins/request-context.js';

const app = fastify({ logger: false }); // the plugin and @centcom/core do the logging
await app.register(requestContextPlugin, { logger: log, metrics }); // first, before routes
```

| Option         | Default           | What it is                                                         |
| -------------- | ----------------- | ------------------------------------------------------------------ |
| `logger`       | (required)        | The service logger; writes the access log                          |
| `metrics`      | no-op             | Receives `http_requests_total` and `http_request_duration_seconds` |
| `newRequestId` | `newId('req')`    | Makes an id for a request without a valid `X-Request-Id`           |
| `clock`        | `performance.now` | Monotonic milliseconds, for `duration_ms`                          |

### Behaviour

- **Request id (CT-ERR rule 4).** A valid `req_` id in `X-Request-Id` is reused; anything else
  (missing, malformed, another prefix, lower case) is replaced by a new id. When the header is
  repeated, only its first value counts. The id is echoed in the `X-Request-Id` response header,
  on errors and 404s too, and is also set as Fastify's `request.id`.
- **Context.** Hooks, the handler and everything they start (awaits, timers, nested calls) see
  the id through `getRequestContext()`, so every log line they write carries `request_id`
  without passing it along. Fastify keeps the context across body parsing itself.
- **Access log.** One `info` line per request, `msg: "http.request"`, with `request_id`, `method`,
  `route` (the route template, such as `/v1/sessions/:id`; `(unmatched)` for a 404), `status`,
  `duration_ms` and `bytes` (when the response has a `Content-Length`). Never the raw URL, the
  query string, headers or bodies. A request the client abandons before the response gets one
  line with `status: 499` and `aborted: true`.
- **Metrics.** `http_requests_total{method, route, status_class}` and
  `http_request_duration_seconds{method, route}` (buckets 5 ms to 30 s). Labels use the route
  template only, never an id or raw path.

### Tests

- **`test/request-context.test.ts`:** id selection, echo and replacement, repeated headers (also
  on the wire), the context across `await`, timers, concurrent requests and body parsing
- **`test/access-log.test.ts`:** one line per request, the route template, no query values,
  headers or bodies, 404s and errors, metric labels, and abandoned requests over a real socket

## Error handler plugin (B006)

`src/plugins/error-handler.ts` makes every error, and every request no route matches, leave the
API as an RFC 9457 `application/problem+json` response (CT-ERR), built by `toProblem` from
`@centcom/core`. Routes throw AppErrors (`forbidden()`, `validationFailed(errors)`, ...); they never
write error responses themselves.

| Option         | Default           | What it is                                                                        |
| -------------- | ----------------- | --------------------------------------------------------------------------------- |
| `logger`       | (required)        | The service logger; writes the `http.error` lines                                 |
| `bodyLimit`    | 262 144 (256 KiB) | Body limit of every route registered after the plugin that sets none (CT-PAGE)    |
| `newRequestId` | `newId('req')`    | Makes an id for a request that has none yet (an error before the request context) |

`frameworkErrorHandler({ logger, newRequestId? })` is Fastify's `frameworkErrors` server option,
for the errors Fastify raises before routing; pass it when creating the server.

### Behaviour

- **Every problem** has `Content-Type: application/problem+json` (exactly: the body is sent as a
  Buffer, so Fastify adds no `charset`), a registry `code`, the `request_id` that is also in
  `X-Request-Id`, the route template as `instance` when a route matched, and `retry_after_s` plus
  a matching `Retry-After` header for 429, 503 and retryable codes.
- **Thrown errors.** AppErrors keep their code, status and detail. Anything else (a `TypeError`, a
  thrown string) is a 500 with a generic detail; its message and stack go only to the log.
- **Fastify's own errors** never pass their message on (it can quote the URL or a header):

  | Fastify error                               | Problem                                                        |
  | ------------------------------------------- | -------------------------------------------------------------- |
  | Malformed JSON, empty JSON body, bad length | 400 `invalid_request`                                          |
  | Body over the route's limit                 | 413 `payload_too_large`                                        |
  | Content type without a parser               | 415 `unsupported_media_type`                                   |
  | A route's Fastify schema fails              | 422 `validation_failed`, `errors[]` with pointers, no Ajv text |
  | Malformed URL, URL segment over 100 chars   | 400 / 414 `invalid_request` (through `frameworkErrorHandler`)  |
  | Any other                                   | By its status (`codeForStatus`)                                |

- **Unmatched requests.** A URL that some route answers under other methods is a 405
  (`invalid_request`, as the registry has no 405 code) with `Allow` listing those methods; any
  other is a 404 `not_found`. Neither echoes the URL.
- **Body limit.** Routes registered after the plugin get 256 KiB unless they set `bodyLimit`
  themselves (`POST /v1/usage/events` takes 1 MiB, CT-PAGE). Register the plugin before any route:
  routes registered earlier keep Fastify's 1 MiB default and are left out of the 405 check.
- **Request id.** Problems use the id the request context plugin gave the request. A request that
  has none yet (a malformed URL, or an error before that plugin's hook) gets the client's valid
  `X-Request-Id` or a new id, echoed in the header.
- **Log.** One `http.error` line per problem, with `status`, `error_code`, `method` and `route`
  (template): `debug` for 4xx, `error` for 5xx, unexpected errors and codes missing from the
  registry (`unexpected: true`). Errors are logged under `err` (redacted); Fastify's own errors only
  by `fastify_code`. Never the URL, query string, headers or body.

### Failure modes

- **Building or sending the problem fails:** the static minimal 500 body (`fallbackProblemBody`)
  goes out instead, logged with `handler_failed: true`.
- **The response had already started** (a stream failed half-way): no second response is
  written; the error is logged with `response_started: true` and the connection is destroyed, so
  the client sees a broken response rather than a truncated one it might trust.

### Tests

- **`test/error-handler.test.ts`:** thrown AppErrors (acceptance 1), contract-validator and Fastify
  schema failures with JSON Pointers (2), retry hints (3), unexpected errors (4), 404, 405, 413,
  400 and 415 (5), no request secret in any response or log line (6), errors before routing, only
  registry codes for any thrown value, uniform authentication failures, and the failure modes

## Users module (B013)

`src/modules/users/` holds the user service over B008's `users` table and the profile field
rules; the SQL is `createUserRepo` in `@centcom/db` (`packages/db/src/repos/users.ts`). Login
methods (B014, B015) call `getOrCreateByEmail`; `/v1/me` (B022) calls `updateProfile`.

```ts
import { newId } from '@centcom/contracts';
import { UserService } from './modules/users/index.js';

const users = new UserService({ db, newId, now: () => new Date() });
const { user, created } = await users.getOrCreateByEmail('Ada@Example.COM', { name: 'Ada' });
await users.updateProfile(user.id, { locale: 'en-GB' });
```

- **First sign-in.** `getOrCreateByEmail` normalises the address (NFC, lower case) and returns
  the existing user with `created: false`. Otherwise it creates the user, a personal workspace
  named after them (slug `p-<workspace ULID>`) and their `owner` membership, all in one
  transaction. Concurrent first sign-ins for one address end with one user: the losers' inserts
  hit `users_email_key`, roll back whole and return the winner.
- **Display name.** The login method's hint, with control characters dropped and cut to 40 code
  points; without a usable hint, the address's local part, cut the same way.
- **Field rules** (`validation.ts`):
  - display name: 1-40 code points after NFC, no control characters;
  - locale: a BCP 47 tag with a 2-3 letter language, stored canonically (`en-gb` becomes `en-GB`; `english` is refused); `en` when unset;
  - avatar slot: 1-64 characters or null;
  - e-mail: at most 254 characters, one `@` with something on each side.

  A bad field is a 422 `validation_failed` AppError whose `errors[]` points at it (`/display_name`), never quoting the value. `validateProfilePatch` reports every bad or unknown field at once.

- **Statuses.** Users pending deletion or deleted are still found by id and by e-mail, with their
  `status`; callers decide what that means.
- **Never logged:** e-mail addresses. The module logs nothing; callers log `usr_` ids.

### Tests

- **`test/modules/users/validation.test.ts`:** the field rules, table-driven.
- **`user-repo.test.ts`:**
  - the exact column list and no query for an impossible address (scripted driver);
  - CRUD, case-insensitive lookups, deletion states, and no extra column after the table grows one (real Postgres).
- **`user-service.test.ts`:**
  - existing users, invalid addresses, the creation race and failure paths (scripted driver);
  - one user for any case of an address, 50 concurrent first sign-ins, and the profile rules end to end (real Postgres).
- **`personal-workspace.test.ts`:** atomic creation, and rollback when the workspace or the membership insert fails (real Postgres).

The real-Postgres cases run where `DATABASE_URL` is set (CI's integration job), each file in a
throwaway `test_<time>_<random>` database migrated to the latest version.
