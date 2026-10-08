# @centcom/api

The Fastify REST API (`/v1/*`, CT-API). It is assembled lane by lane; today it holds the request
context plugin (B005), the error handler plugin (B006), the users module (B013), e-mail sign-in
(B014), social login (B015), the token service with the auth plugin (B017), the RBAC plugin
(B021), the account routes (B022), the rate-limit plugin (B023), the idempotency plugin (B024)
and the pagination plugin (B025). Logging and the error types themselves live in `@centcom/core`
([`packages/core/README.md`](../../packages/core/README.md#logging-b005),
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

## Tokens and authentication (B017)

`src/modules/auth/tokens/` is the one token service (CT-AUTH): EdDSA access tokens, rotating
refresh tokens with reuse detection, revocation, relay tickets and the JWKS.
`src/plugins/auth.ts` authenticates every other request through it.

```ts
import { createMemoryRedis } from '@centcom/core';
import { loadTokenKeys, TokenService } from './modules/auth/tokens/index.js';
import { authPlugin } from './plugins/auth.js';
import { revokeRoutes } from './routes/auth/revoke.js';
import { tokenRoutes } from './routes/auth/token.js';
import { wellKnownRoutes } from './routes/well-known.js';

const tokens = new TokenService({ db, keys: loadTokenKeys(), kv: redis.kv, logger: log, metrics });
await app.register(requestContextPlugin, { logger: log, metrics }); // first
await app.register(errorHandlerPlugin, { logger: log }); // then
await app.register(authPlugin, { tokens }); // then, before any route
await app.register(tokenRoutes, { tokens });
await app.register(revokeRoutes, { tokens });
await app.register(wellKnownRoutes, { tokens });
app.get(
  '/v1/me',
  { config: { auth: { scopes: ['profile'] } } },
  async (request) => request.principal,
);
```

| Endpoint                     | Auth              | What it does                                                                                                                                                                   |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/auth/token`        | public            | Form or JSON; `client_id` one of `centcom-cli`, `centcom-web` (with `X-Centcom-Client: web`), `centcom-tui`; dispatches `grant_type` to its handler; `Cache-Control: no-store` |
| `POST /v1/auth/revoke`       | bearer, `profile` | RFC 7009: `{token}` revokes that refresh token's family, `{device}` the device, both only the caller's; always 200, empty                                                      |
| `GET /.well-known/jwks.json` | public            | The public keys (`OKP`/`Ed25519`, never `d`), active key first; `Cache-Control: public, max-age=300`                                                                           |

- **Access tokens:** JWT, `alg` EdDSA with `kid` and `typ` `at+jwt`, 15 min. The claims are
  `iss` `https://api.centcom.dev`, `sub`, `aud` `centcom-api`, `exp`, `iat`, `jti`, `scp`, `dev`,
  `wsp`, `plan` and `ent` (from an `EntitlementsLookup`; default `free`/0).
  - Verification accepts only EdDSA by a published key, the issuer, audience and type, and 60 s
    of clock skew.
  - It then checks the Redis flags (`revoked:jti:<jti>`, `revoked:dev:<id>`, 16 min).
  - A failure is `token_expired`, `token_invalid`, `token_revoked` or `device_revoked`: one body
    per code.
- **Refresh tokens:** 32 random bytes (base64url), stored only as SHA-256 in `refresh_tokens`
  ([db README](../../packages/db/README.md#refresh-tokens-b017)).
  - Every use rotates the token in one transaction that locks its row, sliding 30 days within
    180 days absolute.
  - A spent token presented again revokes the whole family (`refresh_reuse_detected`, logged as
    `auth.refresh_reuse_detected` with the family id).
  - Every other problem is one `invalid_grant` body.
  - `scope` on a refresh may narrow the access token, never widen it.
- **Hooks for other lanes:**
  - `issueTokens({userId, deviceId, scopes, workspaceId?, clientId?})` for grant handlers;
  - `registerGrantHandler(grantType, handler)` (B016, B018);
  - `registerPrincipalResolver(prefix, resolver)` (B019, `cen_`);
  - `revokeDevice(deviceId)` (B020);
  - `revokeFamily`, `revokeAccessJti(jti, expUnix)`;
  - `mintRelayTicket({sid, mid, role, dev, caps})` (60 s, `aud` `centcom-relay`).
- **Auth plugin:**
  - Routes authenticate unless `config: { auth: false }`; `config: { auth: { scopes } }` adds
    required scopes (403 `forbidden`).
  - No or malformed `Authorization: Bearer` header: 401 `unauthorized`.
  - 401s carry `WWW-Authenticate`.
  - Unmatched routes stay 404.
- **Redis down:** tokens with the `admin` scope fail closed (503). The rest fail open until they
  expire, counted in `auth_revocation_unavailable_total` and logged (ids only) once a minute.
- **Never logged or echoed:** tokens. The flow test captures every log line and checks.

### Configuration

The lane's keys are declared in `config.ts` (`tokenEnvSchema`, read by `loadTokenKeys()`).
`docs/config.md` cannot list them yet: its generator lives in `@centcom/core`, which cannot
import the API.

| Key                 | Secret | What it is                                                                                                                 |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SIGNING_KEYS` | yes    | JSON array of Ed25519 JWKs `{kty: "OKP", crv: "Ed25519", kid, x, d}`; keys without `d` are published for verification only |
| `AUTH_SIGNING_KID`  | no     | `kid` of the key that signs new tokens; it must have `d`                                                                   |

Without a key that can sign, `loadTokenKeys()` throws a `ConfigError` and the API does not start.
A new key: `generateSigningJwk('<kid>')` from the module (keep the output secret).

**Rotation** (at least every 90 days):

1. Add the new key to `AUTH_SIGNING_KEYS` and deploy: it is published but does not sign.
2. After at least 5 minutes (the JWKS cache), point `AUTH_SIGNING_KID` at it and deploy.
3. After 15 minutes more (the old key's last tokens expired), remove the old key's `d`; drop the
   old key at the next rotation.

### Tests

`test/modules/auth/tokens/`:

- **`jwt.test.ts`:** claims, skew, `none`/HS256, keys, audiences, types.
- **`jwks.test.ts`:** public keys only, rotation overlap, the route.
- **`refresh.test.ts`:**
  - the rotation table;
  - in-memory flows: rotation, reuse, sliding and absolute expiry on a moved clock, scopes, issue checks;
  - real Postgres: rotation, reuse, 100 parallel refreshes, expiry, devices, hashes only.
- **`revocation.test.ts`:** jti, device, family, TTLs, Redis down.
- **`auth-plugin.test.ts`:** headers, principal, scopes, resolvers.
- **`errors.test.ts`:** uniform bodies.
- **`routes.test.ts`:** the endpoints and a full flow whose logs hold no token.
- **`relay-ticket.test.ts`** and **`config.test.ts`.**

The in-memory refresh store in `helpers.ts` decides with the same `decideRotation` as the
Postgres one. The Postgres cases run where `DATABASE_URL` is set (CI's integration job).

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

## Rate-limit plugin (B023)

`src/plugins/rate-limit.ts` counts every request against its CT-PAGE bucket in an `onRequest`
hook, before body parsing and any handler. The policy behind it (keys, client addresses, the
fallback and the abuse block) is in `@centcom/core`
([README](../../packages/core/README.md#rate-limiting-b023)).

```ts
await app.register(rateLimitPlugin, {
  store: redis.rateLimit,
  kv: redis.kv,
  config: rateLimitConfig(base),
  principal: (request) => principalOf(request), // the auth plugin's principal, once B017 is in
  logger,
  metrics,
}); // after the request context, error handler and auth plugins; before any route
app.post('/v1/usage/events', { config: { rateLimit: { bucket: 'usage' } } }, handler);
```

- **Buckets:** a route declares `config.rateLimit = { bucket, cost? }`.
  - `default` is the caller's own bucket: anonymous callers per address, users and API keys per
    id. Routes under `/v1/auth/` default to `auth` (per address).
  - An unknown bucket, or a cost above the bucket's smallest limit, fails at startup.
- **Headers:** every counted response (200, 404, 405 and 429 alike) carries `RateLimit-Limit`,
  `RateLimit-Remaining` and `RateLimit-Reset` (whole seconds).
  - Past the limit: 429 `rate_limited` with `Retry-After` and `retry_after_s`, one body for every
    bucket.
- **Route templates, never URLs:** `/v1/things/1` and `/v1/things/2?x` are one route. Unmatched
  URLs (404, 405) count in the caller's own bucket.
- **Exempt:** `/healthz` and `/readyz` (`config.exempt`), matched by route template.
- **Order:** register it after the auth plugin, whose principal it reads.
  - Requests that plugin refuses (401) are answered before the limiter runs.
  - A `principal` function that throws a failed credential's 401 instead gets the request counted
    as anonymous first: past the anonymous limit the answer is 429, otherwise its own error.
  - Without a `principal` function, everyone counts as anonymous.
- **Tests:** `test/rate-limit.test.ts` covers acceptance 1-9 end to end, the guardrails and the
  route config checks.

## Idempotency plugin (B024)

`src/plugins/idempotency.ts` applies CT-PAGE's `Idempotency-Key` to POST routes that declare
it; the records behind it are in `@centcom/core`
([README](../../packages/core/README.md#idempotency-b024)).

```ts
await app.register(idempotencyPlugin, {
  kv: redis.kv,
  ...idempotencyConfig(), // IDEMPOTENCY_ENCRYPTION_KEY, for sensitiveResponse routes
  principal: (request) => principalIdOf(request), // the auth plugin's principal, once B017 is in
  logger,
  metrics,
}); // after the request context, error handler and auth plugins; before any route
app.post('/v1/workspaces/:id/invites', { config: { idempotency: 'required' } }, handler);
app.post('/v1/keys', { config: { idempotency: 'required', sensitiveResponse: true } }, handler);
```

- **Route config:** `idempotency: 'required' | 'accepted'`, `sensitiveResponse?` and
  `maxStoredBytes?` (default 256 KiB, at most 1 MiB). Anything the plugin cannot honour fails at
  startup: a non-POST route, `sensitiveResponse` without a key, a bad size.
- **A request with a key**, after parsing and before the handler:
  - the first request runs, and its response (2xx and 4xx, never 5xx) is kept for 24 h;
  - the same request again gets that response with `Idempotency-Replayed: true`, and the handler
    does not run;
  - a different request under the key: 409 `idempotency_conflict`;
  - a duplicate of a request still running waits up to 10 s, then gets 409 `conflict` with
    `Retry-After: 1`.
- **Keys:** a missing key on a `required` route is 400 `idempotency_key_required`. A key that is
  not one ULID or UUID (at most 64 characters) is 422 with `errors[].pointer`
  `/headers/idempotency-key`. Keys are scoped by principal, method and route template.
- **Store down:** `required` routes answer 503 with `retry_after_s: 1` and never run unprotected.
  `accepted` routes run without the guarantee (`idempotency_unprotected_total`, and
  `idempotency.unprotected` at most once a minute).
- **Responses that cannot be kept** are still served, and their key is freed: oversized, streamed,
  hijacked, or a failed write (`idempotency_store_errors_total`, `idempotency.store_failed`).
- **Tests:** `test/idempotency.test.ts` covers acceptance 1-9 end to end, the guardrails, the
  failure policy and the route config checks.

## Pagination plugin (B025)

`src/plugins/pagination.ts` adds `reply.page(data, nextCursor)`, which sends CT-PAGE's
`{data, next_cursor, has_more}`; register it before list routes. The paging itself is in
`@centcom/core` ([README](../../packages/core/README.md#pagination-b025)).

```ts
await app.register(paginationPlugin);
app.get('/v1/things', async (request, reply) => {
  const query = parsePageQuery(request.query, {
    sorts: ['-created_at'],
    defaultSort: '-created_at',
  });
  const result = await paginate(db.selectFrom('things').selectAll(), SPEC, {
    ...query,
    filterHash,
    keys,
    now,
  });
  return reply.page(result.data, result.next_cursor);
});
```

- **Shape:** `has_more` is whether `next_cursor` is set; there are no totals, offsets or page
  numbers. Misuse (data that is not an array) is a 500, never a malformed list.
- **Tests:** `test/pagination.test.ts`.
  - Over HTTP: 1 000 items in pages of 200, the default limit, empty lists, bad limits and
    offsets, and tampered, re-filtered, re-sorted and expired cursors.
  - On Postgres 16 (CI's integration job): 1 000 rows, inserts racing the pages, ties,
    microsecond timestamps, parameter-only SQL, and an index scan on 100 000 rows.

## E-mail sign-in (B014)

Passwordless sign-in with a one-time link (`src/modules/auth/magic-link/`,
`src/routes/login-email.ts`, outside the /v1 contract). The link is mailed through B032's email
service (template `magic_link`); signing in ends in the same `LoginCompleter` as social login
(B018 wires the web session).

```ts
const config = loadMagicLinkConfig(); // MAGIC_LINK_TTL_S, MAGIC_LINK_BASE_URL, LOGIN_RETURN_TO_ALLOWLIST
const magicLink = new MagicLinkService({
  store: createLoginTokenStore(db),
  mailer: emailMagicLinkMailer(emailService, config.ttlS),
  users: userService,
  rateLimit: redis.rateLimit,
  returnTo: config.returnTo,
  baseUrl: config.baseUrl,
  ttlS: config.ttlS,
  logger,
  metrics,
});
await app.register(emailLoginRoutes, { magicLink, completer, ttlS: config.ttlS, logger });
// on shutdown: await magicLink.idle();
```

| Route                        | Answers                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /login/email`          | `{email, return_to?}` (form or JSON): 202 and the same page for every address, plus the browser's nonce cookie; 422 for a malformed address |
| `GET /login/email/verify?t=` | A page whose button posts the link back; nothing else happens (mail scanners use nothing up)                                                |
| `POST /login/email/verify`   | `{t, csrf}` with the nonce cookie: signs in, then 303 to `return_to`; any failure gets one generic page (400)                               |

- **No account enumeration:** a request does the same work for every address: no account is
  looked up, and the mail goes out in the background after the response. Every valid address gets
  a link; the account is found, or created, when the link is used.
- **Links:**
  - The token is 32 bytes from the CSPRNG; only its sha256 is stored (`login_tokens`, migration
    `20260102000500`).
  - A link lasts `MAGIC_LINK_TTL_S` (15 minutes) and is used at most once, in one statement.
  - It works only with the nonce cookie of the browser that asked for it (HttpOnly,
    SameSite=Lax, `Path=/login/email`), and only with the CSRF token the confirm page carries.
- **Accounts:** `pending_deletion` and `deleted` accounts fail like a bad link.
- **Limits:** 5 links per address per hour (beyond it nothing is sent, and the answer is the same
  202). Both POSTs count in the rate limiter's `auth` bucket (20/min per client address, B023).
- **return_to:** only exact matches of `LOGIN_RETURN_TO_ALLOWLIST` (shared with social login);
  anything else becomes its first entry.
- **Failures:** a mail that fails 3 times (backoff 1 s, 2 s) gives its link up
  (`magic_link_mail_failures_total`). A token store or limiter failure is a 503 with
  `retry_after_s`.
- **Logs:** hashed-address prefixes (`email_hash`, 12 hex digits) and `usr_` ids only; never a
  token, link, nonce or address.
- **Pages:** no scripts or styles, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and
  CSP `default-src 'none'; form-action 'self'`.

### Configuration

| Key                         | Default | Required | What it is                                                                |
| --------------------------- | ------- | -------- | ------------------------------------------------------------------------- |
| `MAGIC_LINK_TTL_S`          | `900`   | no       | How long a link works, in seconds (60 to 3600)                            |
| `MAGIC_LINK_BASE_URL`       |         | yes      | Public base URL of the API: links are `<base>/login/email/verify?t=...`   |
| `LOGIN_RETURN_TO_ALLOWLIST` |         | yes      | Comma-separated URLs a login may return to (exact match); first = default |

### Tests

`test/modules/auth/magic-link/`:

- **`service.test.ts`:** single use, expiry, the nonce and CSRF binding, hash-only storage, logs,
  address spellings, closed accounts, mail failures, the store down, and the mailer adapter.
- **`enumeration.test.ts`:** byte-identical answers, timing, and no account lookup while
  answering.
- **`limits.test.ts`:** the per-address and per-IP limits.
- **`redirect.test.ts`:** the `return_to` matrix.
- **`prefetch.test.ts`:** GETs change nothing; the page headers.
- **`store.test.ts`:** the Postgres store and the whole flow with B013 (CI).

## Workspaces (B027)

Workspace CRUD (`src/modules/workspaces/`, CT-API-WORKSPACES). The SQL is `createWorkspaceStore` in
@centcom/db; the purge job is `workspace-purge` in @centcom/worker.

```ts
const service = new WorkspaceService({
  store: createWorkspaceStore(db),
  events: redis.pubsub,
  purgeQueue: createWorkspacePurgeQueue({ connection, prefix }), // @centcom/worker
  maxOwned: loadWorkspacesConfig().maxOwned, // WORKSPACES_MAX_OWNED
  logger,
  metrics,
});
service.extensions.register(settings.patchExtension()); // B034: owns PATCH `settings`
// after the request-context, error-handler, idempotency, RBAC and audit plugins:
await app.register(workspaceRoutes, { service, cursorKeys: paginationConfig().signingKeys });
```

| Route                        | Scope              | Who     | Answers                                                                |
| ---------------------------- | ------------------ | ------- | ---------------------------------------------------------------------- |
| `GET /v1/workspaces`         | `workspaces:read`  | any     | The caller's workspaces, newest first (CT-PAGE; an API key's: its own) |
| `POST /v1/workspaces`        | `workspaces:write` | users   | 201 with the caller as owner, `ETag`, `Location`; `Idempotency-Key` OK |
| `GET /v1/workspaces/{id}`    | `workspaces:read`  | member+ | The workspace and its `ETag`; a guest sees `{id, name}`                |
| `PATCH /v1/workspaces/{id}`  | `workspaces:write` | admin+  | `If-Match` required (400 without, 412 stale); 200 with the new `ETag`  |
| `DELETE /v1/workspaces/{id}` | `workspaces:write` | owner   | 204; from then on every read is a 404 and the purge is queued          |

- **Who may know:** authorisation is B021's RBAC only. A caller who is not a member (or whose
  workspace was deleted) gets 404 `not_found` whatever they asked; a member whose role falls short
  gets 403, and privileged denials are audited.
- **Create:** the workspace and its `owner` membership in one transaction (one owner per workspace
  is also a unique index). The slug is the caller's (taken: 409) or made from the name (`Café
Crème` → `cafe-creme`), with the next free numeric suffix; a slug race retries up to 5 times,
  then 409. A user owns at most `WORKSPACES_MAX_OWNED` live workspaces (409 beyond).
- **Update:** the row is locked and the ETag checked, then the name and the extension fields
  change and the version moves on, in one transaction: of two PATCHes with one ETag exactly one
  wins. Unknown fields are ignored; a body with nothing to change is a 422. Extensions
  (`service.extensions.register({key, parse, apply})`) own fields such as `settings`: `apply`
  runs in the transaction with the request's audit context, and may return a step (an
  announcement) that runs after the commit.
- **Delete:** hides the workspace and writes `workspace.delete` (account-level, so it outlives the
  purge) in one transaction; then announces `workspace.deleted` on `centcom:workspace-events`,
  drops cached roles (`rbac:invalidate`) and queues `workspace-purge` (job `purge-<wsp>`). Their
  failures are logged and counted (`workspace_announce_failures_total`,
  `workspace_purge_enqueue_failures_total`); the purge job announces again first.
- **Audit:** `workspace.create`, `workspace.update` (`meta.fields`) and `workspace.delete`, each
  written in its change's transaction through `request.audit`.

### Configuration

| Key                    | Default | Required | What it is                                                  |
| ---------------------- | ------- | -------- | ----------------------------------------------------------- |
| `WORKSPACES_MAX_OWNED` | `20`    | no       | Live workspaces one user may own (1 to 1000); more is a 409 |

### Tests

`test/modules/workspaces/`:

- **`workspaces.routes.test.ts`:** CRUD, ETag and If-Match, the role matrix, 404s, delete and
  purge queueing, limits, idempotent replays, API keys, failure modes, contract validation.
- **`workspaces.pagination.test.ts`:** 120 workspaces, limits, cursors across changes and callers.
- **`workspaces.validation.test.ts`:** names, slugs (property tests).
- **`workspaces.postgres.test.ts`:** the routes over the SQL store (CI).

## Workspace settings (B034)

A workspace's policies (`src/modules/workspace-settings/`, CT-API-WORKSPACES `WorkspaceSettings`):
the default auto-approve level, history sharing and the retention override. The SQL is
`createWorkspaceSettingsStore` in @centcom/db; the purge hook is `workspace-settings` in
@centcom/worker.

```ts
const settings = new WorkspaceSettingsService({
  store: createWorkspaceSettingsStore(db),
  entitlements: freePlanHistoryDays, // B069's reader of `history_days` when it exists
  events: redis.pubsub,
  logger,
  metrics,
});
service.extensions.register(settings.patchExtension()); // `settings` in PATCH /v1/workspaces/{id}
await app.register(workspaceSettingsRoutes, { service: settings }); // after the workspace routes
```

| Route                                  | Scope              | Who     | Answers                                                       |
| -------------------------------------- | ------------------ | ------- | ------------------------------------------------------------- |
| `GET /v1/workspaces/{id}/settings`     | `workspaces:read`  | member+ | The settings and their `ETag` (`"s<version>"`); guests: 403   |
| `PATCH /v1/workspaces/{id}/settings`   | `workspaces:write` | admin+  | `If-Match` required (400 without, 412 stale); 200, new `ETag` |
| `PATCH /v1/workspaces/{id}` `settings` | `workspaces:write` | admin+  | The same change under the workspace's `ETag`                  |

- **Defaults:** `auto_approve` `ask`, `share_history` true, `history_retention_days` null, ETag
  `"s0"`, until the first change creates the row. The settings' ETags (`"s…"`) are their own: a
  workspace ETag (`"v…"`) never matches them, and the other way round.
- **Values:** `auto_approve` is exactly `ask`, `trusted` or `everyone` (CT-WS-QUEUE rule 3 /
  `control.policy`); `share_history` a boolean; `history_retention_days` null (the plan's) or whole
  days up to the plan's `history_days` (422 above; 503 `retry_after_s: 1` while entitlements are
  unavailable, for that field only). Unknown fields are ignored and never stored; a body naming no
  setting is a 422.
- **One code path:** both routes lock the workspace row, check the ETag, check the cap, write the
  row with the next version and audit, in one transaction; two PATCHes with one ETag: one 200, one 412. A change that changes nothing writes nothing (the ETag stays).
- **Audit:** `workspace.update` with `fields` (the changed keys) and each one's `*_from` / `*_to`
  (`auto_approve`, `share_history`, `retention_days`): enums, flags and days, no text. Through the
  workspace PATCH, B027's own `workspace.update` (`fields: settings`) is written too.
- **Announce:** after the commit, one `workspace.settings_changed` `{wsp, changed, at}` on
  `centcom:workspace-events` (the relay and the retention job re-read the settings); tried 4 times
  (100, 200, 400 ms apart), then logged (`workspace.settings_publish_failed`) and counted
  (`workspace_settings_publish_failures_total`): the stored value stands.
- **Defaults only:** the server never pushes settings into a live session; the host client applies
  them through `control.policy`.

### Tests

`test/modules/workspace-settings/`:

- **`workspace-settings.routes.test.ts`:** defaults and the first PATCH, the role matrix, 404s,
  If-Match and ETags, two PATCHes with one ETag, API keys, contract validation.
- **`workspace-settings.validation.test.ts`:** the enum, bounds and the plan's cap (CT-ENTITLEMENTS
  fixtures), `null`, unknown fields, an entitlements outage, a property test over random bodies.
- **`workspace-settings.extension.test.ts`:** `settings` in the workspace PATCH: same stored result,
  one version step each, refusals under `/settings` that roll the rename back.
- **`workspace-settings.events.test.ts`:** one message with only the changed keys, audit meta,
  no-op PATCHes, publish retries.
- **`workspace-settings.postgres.test.ts`:** the routes over the SQL stores, ten racing PATCHes,
  constraints, audit rows and the purge (CI).

## Members (B028)

Workspace members (`src/modules/members/`, CT-API-WORKSPACES). The SQL is `createMemberStore` in
@centcom/db; `memberOperations(trx)` gives the same operations inside another lane's transaction.

```ts
const members = new MembershipService({
  store: createMemberStore(db),
  events: redis.pubsub,
  logger,
  metrics,
});
// after the workspace routes' plugins (request context, errors, idempotency, RBAC, audit):
await app.register(memberRoutes, { members, workspaces: createWorkspaceStore(db), cursorKeys });
// B029, accepting an invite inside its own transaction:
await withTransaction(db, (trx) =>
  members.add(memberOperations(trx), wspId, userId, 'member', ctx),
);
```

| Route                                         | Who                   | Answers                                                 |
| --------------------------------------------- | --------------------- | ------------------------------------------------------- |
| `GET /v1/workspaces/{id}/members`             | member+               | Oldest first (CT-PAGE); addresses for owners and admins |
| `PATCH /v1/workspaces/{id}/members/{mem}`     | owner, admin          | `{role}` (never `owner`): 200 with the member           |
| `DELETE /v1/workspaces/{id}/members/{mem}`    | owner, admin, or self | 204; the owner leaving is a 409 (transfer first)        |
| `POST /v1/workspaces/{id}/transfer-ownership` | owner                 | `{to_member}` (an admin): 200 with the workspace        |

- **RBAC (CT-RBAC):** the owner gives any role but owner to anyone else; an admin gives member,
  billing or guest to members, billing and guests, and removes them; anyone but the owner leaves.
  Outsiders get 404; refusals are 403, audited as `permission.denied`.
- **Concurrency:** each change locks the target's row and answers 409 if its role moved since the
  caller read it. Removals and transfers lock the workspace row first, so they take turns: of two
  transfers, one wins and the other is a 409. One owner per workspace is also a unique index
  (B027), and a transfer demotes before it promotes. A deadlocked transfer is retried once.
- **Views:** owners and admins see `{id, user, display_name, email, role, joined_at}`; members and
  billing the same without `email`; guests `{id, display_name, role}` (CT-RBAC).
- **After each change** (after the commit): `{type: 'role_changed' | 'removed' | 'left', wsp, mem,
user, role?, at}` on `centcom:membership`, and the member's cached role is dropped
  (`rbac:invalidate`). A publish that fails is retried 3 times with jitter, then counted
  (`membership_event_publish_failed_total`) and logged.
- **Audit:** `member.role_change` (a transfer writes two), `member.remove` (`meta.self` when
  leaving), `member.add`; refused owner-rule attempts (leaving as owner, a transfer that cannot
  happen) are audited with outcome `denied`.

### Tests

`test/modules/members/`:

- **`members.rbac.matrix.test.ts`:** every actor role × target role × change and removal.
- **`members.owner-invariant.test.ts`:** 50 concurrent transfers and removals, one owner after.
- **`members.events.test.ts`:** announcements, audit rows (denied too), transfers, retries.
- **`members.list.test.ts`:** paging and who sees addresses.
- **`members.postgres.test.ts`:** the routes and the 50-attempt storm over Postgres (CI).

## Invites (B029)

Workspace invites (`src/modules/invites/`, CT-API-WORKSPACES). The SQL is `createInviteStore` in
@centcom/db; the expiry job and the purge hook are `invite-expiry` in @centcom/worker.

```ts
app.decorate('seatGate', seatGate); // B030: refuses a member when no seat is free
const invites = new InviteService({
  store: createInviteStore(db),
  members, // B028's MembershipService
  urls: inviteUrlBuilder, // B033: inviteUrl(token), joinUrl(token)
  email: emailService, // B032: queues workspace_invite
  logger,
  metrics,
});
// after the member routes' plugins; the idempotency plugin needs its encryptionKey:
await app.register(inviteRoutes, { service: invites, workspaces, cursorKeys });
```

| Route                                | Scope              | Who                   | Answers                                                     |
| ------------------------------------ | ------------------ | --------------------- | ----------------------------------------------------------- |
| `POST /v1/workspaces/{id}/invites`   | `workspaces:write` | owner, admin          | 201 with `token` and `url`; `Idempotency-Key` required      |
| `GET /v1/workspaces/{id}/invites`    | `workspaces:read`  | owner, admin          | Pending invites, oldest first (CT-PAGE), without tokens     |
| `DELETE /v1/invites/{id}`            | `workspaces:write` | owner, admin          | 204; from then on every use of the invite is a 410          |
| `GET /v1/invites/{token}`            | none               | anyone                | Workspace and inviter names, role, expiry, `has_key_bundle` |
| `POST /v1/invites/{token}/accept`    | `profile`          | users                 | 201 `{workspace, member}`; `Idempotency-Key` accepted       |
| `PUT /v1/invites/{id}/key-bundle`    | `sessions:host`    | a host of the space   | 204                                                         |
| `GET /v1/invites/{token}/key-bundle` | `profile`          | the user who accepted | `{bundle}`, once; then 410                                  |

- **Tokens:** 160 bits from the CSPRNG, base64url; only their sha256 is stored, and invites are
  found by it. A token is in the create response and the invite e-mail, nowhere else: logs carry
  route templates, and the create's idempotency record keeps its copy encrypted
  (`sensitiveResponse`). The key in a link's fragment (`#k=`) never reaches the server: a `k`
  query parameter is a 400.
- **Create:** the seat gate is asked, an address that is a member's is a 409 `member_exists`, a
  second pending invite for an address a 409 (without the first one's id), and the invite is
  inserted and audited (`invite.create`, `meta.role` and `meta.kind`), in one transaction. After
  the commit an address invite queues `workspace_invite` (its idempotency key is the invite id);
  a mail that cannot be queued is logged and counted (`invite_mail_failures_total`), and the
  invite stands.
- **Statuses:** pending until accepted, revoked or expired, at `expires_at` exactly (7 days).
  Unknown tokens are a 404 `invite_invalid`; expired, revoked and used invites a 410
  (`invite_expired`, `invite_revoked`, `gone`). The preview counts in the anonymous rate-limit
  bucket (30 a minute per address).
- **Accept:** locks the invite row (the same user again gets the same membership), checks the
  address binding (403), locks the workspace row (a member already: 409), marks the invite
  accepted, asks the seat gate (a refusal is a 403 of the entitlement family that changes
  nothing) and adds the member (`member.add`, `via: invite`), auditing `invite.accept`, in one
  transaction. Accepts for the last seat take turns on the workspace row: one wins.
- **Key bundles (CT-CRYPTO §4):** opaque bytes, at least 48 (a sealed box's overhead), at most
  16 KiB of base64url (413 beyond). A host of a pending, live or paused session of the workspace
  stores one while the invite is pending, or after acceptance until it is fetched, for 15 minutes
  (403 `host_required` for anyone else, 410 when too late). Only the user who accepted fetches it
  (403 for anyone else: the token alone is not enough), once. It goes when fetched, revoked or
  expired, or 15 minutes after acceptance. It is never logged.
- **Fail closed:** registering `inviteRoutes` without the `seatGate` decorator throws, so the API
  cannot start without seat checks.

### Tests

`test/modules/invites/`:

- **`invites.lifecycle.test.ts`:** create, list, preview, accept, revoke and expiry with a fake
  clock, the role matrix, contract validation.
- **`invites.token-secrecy.test.ts`:** no token in rows, audit events, logs, lists, error bodies
  or the idempotency record; `?k=` refused.
- **`invites.seat-race.test.ts`:** refusals, 10 parallel accepts for the last seat, B030's count.
- **`invites.key-bundle.test.ts`:** sizes, hosts only, fetch once, deletion on revocation, expiry
  and 15 minutes after acceptance.
- **`invites.idempotency.test.ts`**, **`invites.ratelimit.test.ts`**.
- **`invites.postgres.test.ts`:** the routes over Postgres, a table dump without tokens, and the
  seat race against the database's locks (CI).
