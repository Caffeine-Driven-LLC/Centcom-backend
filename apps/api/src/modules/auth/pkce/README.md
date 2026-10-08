# Browser sign-in: authorization code + PKCE (B018)

The web app (and any public client that wants a browser login) signs in with the authorization
code flow and PKCE `S256` ([CT-AUTH](../../../../../../contracts/01-auth-rbac.md)). This module
holds the authorize endpoint's logic, the one-time codes, the `authorization_code` grant for
B017's token endpoint, and the redirect URI allow-list. `../web-session/` holds the browser login
session (`centcom_sid`) and the web client's refresh cookie (`centcom_rt`).

## Flow

1. The client opens `GET /v1/auth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state[&scope]`.
2. The request is checked first: unknown client (401 `invalid_client`), a `redirect_uri` not on
   the client's allow-list, `plain` or a missing method, a malformed challenge or a missing
   `state` (400 `invalid_request`), a bad scope (400 `invalid_scope`). Errors are problem
   responses; nothing ever redirects on an error.
3. Without a login session the browser goes to `WEB_LOGIN_URL?return_to=<signed>`. The signed
   `return_to` is a JWT (B017 keys, `typ` `centcom-return-to+jwt`, audience `centcom-login`, one
   hour) holding this authorize URL; `openReturnTo` gives it back, or null when it was tampered
   with, expired or is something else.
4. With a session the browser goes to `redirect_uri?code=…&state=…` (`state` unchanged). The code
   is 256 random bits, kept in Redis under its SHA-256 for 60 s with the client, redirect URI,
   challenge, user and scope.
5. The client posts `grant_type=authorization_code&code&code_verifier&redirect_uri&client_id` to
   `POST /v1/auth/token`. The code is claimed once (`setIfAbsent`); client, redirect URI and
   verifier must match; tokens come from `TokenService.issueTokens`. Any failure about the code
   is 400 `invalid_grant`. A replayed code revokes the access token (by `jti`) and the refresh
   family its first exchange issued.

## Wiring

```ts
const pkce = loadPkceConfig(); // ConfigError: the API refuses to start
const codes = new AuthorizationCodeStore({ kv: redis.kv });
const sessions = createLoginSessions({ kv: redis.kv });
registerAuthorizationCodeGrant({ tokens, codes, logger });
await app.register(webTokenCookiePlugin, { allowedOrigins: pkce.allowedOrigins }); // before tokenRoutes
await app.register(tokenRoutes, { tokens });
await app.register(authorizeRoutes, {
  authorizer: new Authorizer({ codes, redirects: pkce.redirects, loginUrl: pkce.loginUrl, keys }),
  sessions,
});
// The login lanes (B014, B015) finish with:
const completer = webLoginCompleter(sessions);
```

## Configuration

| Key                   | Default                               | Rule                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_REDIRECT_URIS`  | CT-AUTH's registered URIs (see below) | JSON `{client_id: [uri, …]}`, known clients, 1 to 16 distinct URIs each. A URI is canonical (as `new URL` prints it), has no credentials, query or fragment, and uses `https`, `http` on 127.0.0.1, [::1] or localhost, or `centcom:`. Clients left out cannot use the flow. |
| `WEB_LOGIN_URL`       | `https://app.centcom.dev/login`       | Absolute http(s) URL without query or fragment.                                                                                                                                                                                                                              |
| `WEB_ALLOWED_ORIGINS` | `https://app.centcom.dev`             | Comma-separated origins (1 to 16); `http` only on a loopback host.                                                                                                                                                                                                           |

Default redirect URIs: `centcom-web` → `https://app.centcom.dev/auth/callback`; `centcom-cli` and
`centcom-tui` → `http://127.0.0.1/callback`, `http://[::1]/callback`, `centcom://auth/callback`.
Matching is exact, except that a loopback IP entry without a port matches any port (RFC 8252
§7.3).

## Web client rules (`webTokenCookiePlugin`)

- `client_id=centcom-web` on the token endpoint needs `X-Centcom-Client: web` and an `Origin` in
  `WEB_ALLOWED_ORIGINS`; otherwise 403 `forbidden`, with no cookie and the code left unclaimed.
- Its refresh token is never in the JSON: it is the `centcom_rt` cookie, `HttpOnly; Secure;
SameSite=Lax; Path=/v1/auth/token; Max-Age=2592000`, rotated on every refresh.
- It refreshes with the cookie only (a `refresh_token` parameter is 400); a failed refresh clears
  the cookie.

## Failure modes

- Redis unavailable: authorize and the exchange answer 503 with `retry_after_s`; there is no
  in-process fallback.
- Login session expired mid-flow: authorize sends the browser to login again with a fresh signed
  `return_to`.
- Invalid configuration: `loadPkceConfig` throws a ConfigError naming the key, never its value.

## Tests

`apps/api/test/modules/auth/pkce/`: `pkce`, `config`, `authorize`, `code-store`, `grant`,
`web-cookie`, `session-store`, `failure`, and `redis` (real Redis, when `REDIS_URL` is set).
