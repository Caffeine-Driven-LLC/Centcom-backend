# @centcom/api

The Fastify REST API (`/v1/*`, CT-API). It is assembled lane by lane; today it holds the request
context plugin (B005), the error handler plugin (B006), the users module (B013), social login
(B015), the RBAC plugin (B021) and the account routes (B022). Logging and the error types themselves
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

## Social login (B015)

`src/modules/auth/social/` signs users in with GitHub or Google (authorization code with PKCE,
as an OAuth client). `src/routes/login-social.ts` serves the browser routes, outside the /v1
contract.

```ts
import {
  createIdentityRepo,
  loadSocialConfig,
  SocialLoginService,
} from './modules/auth/social/index.js';
import { socialLoginRoutes } from './routes/login-social.js';

const config = loadSocialConfig(process.env, (warning) => log.warn(warning)); // in main.ts
const social = new SocialLoginService({
  config,
  users: userService,
  identities: createIdentityRepo(db),
});
await app.register(socialLoginRoutes, { social, completer, logger: log }); // completer: B018's web session
```

| Route                                               | What it does                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /login/{github\|google}?return_to=`            | Sets the signed state cookie, answers 302 to the provider's authorize URL                            |
| `GET /login/{github\|google}/callback?code=&state=` | Checks the callback, signs the user in, hands over to `LoginCompleter.complete` (303 to `return_to`) |

- **State:** a random `state`, the PKCE verifier (S256) and Google's `nonce` travel in
  `centcom_oauth`, a cookie signed with HMAC-SHA256 (`SOCIAL_STATE_SECRET`).
  - The cookie is valid 10 minutes, `HttpOnly`, `SameSite=Lax`, `Path=/login` and `Secure`.
  - A missing, forged, expired or mismatched state is refused before any provider call.
- **GitHub:** scopes `read:user user:email`. The account's numeric id comes from `GET /user`.
  The e-mail is the primary address from `GET /user/emails`, used only when GitHub marks it
  verified.
- **Google:** scopes `openid email profile`. The ID token is verified in full: RS256 by a key of
  Google's JWKS (one refetch for an unknown `kid`, at most once a minute), `iss`, `aud`, `exp`
  (60 s skew), our `nonce`, and `email_verified` true.
- **Matching:** `identities(provider, subject, user_id)`.
  - An account seen before signs in as its user, whatever its e-mail is now.
  - Otherwise its verified e-mail is the user's: B013's `getOrCreateByEmail` finds or creates
    that user, and the account is linked to it.
  - Concurrent first logins end with one user and one identity; the identities primary key
    decides who links first.
- **Nothing kept from the provider** but the account id. Codes, tokens and the client secret are
  used in memory only. Logs carry the provider and outcome (`auth.social_login`,
  `auth.social_login_failed` with `reason` and `status`), never codes, tokens or addresses.
- **Failures** get a plain page:
  - 400: state, declined, no verified e-mail, an invalid identity;
  - 502: the provider was down or slower than 5 s (`PROVIDER_TIMEOUT_MS`).

  No account changes on any failure. A provider without its client id or secret is off: its
  routes answer 404 and a warning is logged at startup.

- **`return_to`** (`src/modules/auth/return-to.ts`, shared with B014) must be exactly one of
  `LOGIN_RETURN_TO_ALLOWLIST`. Anything else, such as `//evil.example`, `javascript:`, other hosts
  or paths, becomes the list's first entry.

### Configuration

The keys are declared in `config.ts` (`socialEnvSchema`, read by `loadSocialConfig()`); like
B017's, they are not in `docs/config.md` yet.

| Key                                        | Secret    | What it is                                                                   |
| ------------------------------------------ | --------- | ---------------------------------------------------------------------------- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `_SECRET` | GitHub OAuth app; both needed or GitHub is off                               |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `_SECRET` | Google OAuth client; both needed or Google is off                            |
| `SOCIAL_REDIRECT_BASE_URL`                 | no        | Public API base; callbacks are `<base>/login/<provider>/callback`            |
| `SOCIAL_STATE_SECRET`                      | yes       | At least 32 characters, the same on every instance; signs the state cookie   |
| `LOGIN_RETURN_TO_ALLOWLIST`                | no        | Comma-separated URLs a login may return to (exact); the first is the default |

### Tests

`test/modules/auth/social/`:

- **`state.test.ts`:** authorize URLs, PKCE, signature, expiry, tampering.
- **`google.test.ts`:** the ID-token matrix with a test JWKS.
- **`github.test.ts`:** e-mail rules, exchange, failures, the time limit.
- **`linking.test.ts`:** matching and races, in memory and on Postgres.
- **`redirect.test.ts`:** `return_to` and configuration.
- **`routes.test.ts`:** the HTTP side.
- **`leak.test.ts`:** nothing secret in logs, pages or the database.

The providers are a fake behind an injected `fetch` (canned JSON, a test RSA key), with no real
credentials.

## RBAC plugin (B021)

`src/plugins/rbac.ts` connects routes to the RBAC engine of `@centcom/core`: register it with
the authorizer and a way to find a request's actor (the auth plugin's principal, once B017 is in),
then guard routes with preHandlers instead of comparing roles.

```ts
await app.register(rbacPlugin, { authorizer, actor: (request) => actorOf(request) });
app.patch(
  '/v1/workspaces/:id',
  {
    preHandler: [
      requireScope('workspaces:write'),
      requirePermission('workspace.update', (req) => ({ workspaceId: req.params.id })),
    ],
  },
  handler,
);
```

- **No actor:** 401 `unauthorized`.
- **A missing scope or a denied action:** 403 `forbidden` with a fixed detail; the authorizer
  audits privileged denials.
- **`requirePermission(…, { hideAs404: true })`** answers 404 `not_found` instead, for resources
  whose existence is not the caller's business.
- **Tests:** `test/rbac-plugin.test.ts`.

## Account: `/v1/me` (B022)

`src/routes/me.ts` serves CT-API-ACCOUNTS' `/v1/me` over `src/modules/me/`. Both routes need the
`profile` scope and a user (API keys get 403); the caller comes from `caller(request)`, the
auth plugin's principal once B017 is in, which also raises the 401 token errors.

```ts
const me = new MeService({
  store: createAccountStore(db),
  audit,
  entitlements: withFreePlanFallback(billing, { logger }),
});
await app.register(meRoutes, { me, caller: (request) => callerOf(request) });
```

| Route          | Answers                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`   | 200 `{user, plan, active_workspace, ent}` (the contract's `Me`) with `ETag`; 404 for a deleted account                                                        |
| `PATCH /v1/me` | Any of `{display_name, locale, avatar, telemetry}` (B013's rules, pointers by API name; unknown fields ignored, `{}` is 422) → 200 `User` with the new `ETag` |

- **ETag and If-Match:** the ETag is `"v<µs of updated_at>"`, a strong ETag naming the user row's
  version.
  - With `If-Match` (strong ETags, or `*`), the update is one compare-and-set statement: two
    writers holding the same ETag cannot both win, and the loser gets 412 `precondition_failed`
    with nothing changed.
  - A no-op patch still honours `If-Match`.
- **Active workspace:** the token's `wsp` claim while the user is still a member of that live
  workspace, else the personal workspace (the first live workspace they created and own; B013
  makes it with the account), else `null`.
- **Plan and `ent`:** from an `EntitlementsLookup` (default: `free`, revision 0).
  `withFreePlanFallback` answers the free plan when billing fails, logging
  `entitlements_unavailable` at most once a minute.
- **Audit:** every successful change records `account.updated` with the field names, never the
  values. A failing sink is logged (`me.audit_failed`) and does not fail the request.
- **Failures:** a deleted account is 404; a pending deletion shows `deletion_scheduled_for` (30
  days after the request); a database timeout or outage is 503 with `retry_after_s: 1`.
- **Responses:** `Cache-Control: private, no-cache`. Email, id and status are never writable.
- **Tests:** `test/routes/me.test.ts` (both routes over an in-memory store) and
  `test/routes/me-store.test.ts` (ETags; the Postgres store and the race, in CI).
