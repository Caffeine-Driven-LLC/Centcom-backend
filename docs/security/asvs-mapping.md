# OWASP ASVS mapping

Lane B098. How the backend answers each part of the OWASP Application Security Verification Standard 4.0.3,
level 2, chapters V2 to V14 (V1, architecture, is covered by [`threat-model.md`](threat-model.md)). This is a
mapping table, not a certification: it says which control meets a part of the standard and which test or
document shows it, and it says plainly where we are partial or where the part does not apply.

`pnpm pentest:check` checks this file: every chapter V2 to V14 appears, every row has a control (a row marked
`n/a` gives its reason), a status of `covered`, `partial` or `n/a`, and every evidence path exists. Controls
cite the threat ids (`TM-...`) of the threat model, which carry the owner lane and the status.

Statuses: **covered** means a control exists and a test or document proves it; **partial** means the control
exists but a part of the section is open (named in the row); **n/a** means the section does not describe
anything this backend does.

The backend never holds plaintext work content (CT-CRYPTO), which removes whole classes of ASVS sections
(for example, content sanitisation for display) from this system; the client has its own mapping.

## V2 Authentication

| Section | Topic                               | Control                                                                                                                                           | Evidence                                                                                                       | Status  |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| V2.1    | Password security                   | Not applicable: nobody has a password. Sign-in is an e-mail link, the device flow or a social identity                                            | -                                                                                                              | n/a     |
| V2.2    | General authenticator security      | Sign-in links are single-use and consumed only by a POST; device codes stored hashed; lock-out and per-address limits (TM-AUTH-03, -04, -05, -10) | `apps/api/test/modules/auth/magic-link/prefetch.test.ts`, `apps/api/test/modules/auth/device/security.test.ts` | covered |
| V2.3    | Authenticator lifecycle             | Refresh tokens rotate with reuse detection; devices and API keys are revocable and revocation is checked on every request (TM-AUTH-02, -09, -11)  | `apps/api/test/modules/auth/tokens/refresh.test.ts`, `apps/api/test/modules/auth/tokens/revocation.test.ts`    | covered |
| V2.4    | Credential storage                  | Not applicable: no password hashes exist. API keys are stored hashed and shown once (TM-AUTH-11)                                                  | `apps/api/test/modules/apikeys`                                                                                | n/a     |
| V2.5    | Credential recovery                 | Recovery is a new sign-in link; the answer is identical for known and unknown addresses (TM-AUTH-04)                                              | `apps/api/test/modules/auth/magic-link/enumeration.test.ts`                                                    | covered |
| V2.6    | Look-up secret verifier             | Not applicable: no look-up secrets or recovery codes are issued                                                                                   | -                                                                                                              | n/a     |
| V2.7    | Out-of-band verifier                | Sign-in links and device user codes expire, are single-use and are rate limited (TM-AUTH-03, -05)                                                 | `apps/api/test/modules/auth/device/rfc8628.test.ts`, `apps/api/test/modules/auth/magic-link/service.test.ts`   | covered |
| V2.8    | Single or multi-factor OTP verifier | Not applicable: no time-based or counter-based one-time passwords are offered                                                                     | -                                                                                                              | n/a     |
| V2.9    | Cryptographic verifier              | Devices hold Ed25519 and X25519 keys; the relay checks signed tickets against the published keys (TM-AUTH-01, TM-RELAY-01)                        | `apps/api/test/modules/auth/tokens/jwks.test.ts`, `apps/relay/test/handshake/handshake.jwks.test.ts`           | covered |
| V2.10   | Service authentication              | API keys are scoped, hashed, revocable and expire; no shared secrets in source (TM-AUTH-11, TM-OPS-03)                                            | `apps/api/test/modules/apikeys`, `infra/security/security.test.ts`                                             | covered |

## V3 Session management

| Section | Topic                             | Control                                                                                                   | Evidence                                                                                                 | Status  |
| ------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| V3.1    | Fundamental session management    | Sessions are tokens, not server cookies: 15-minute access tokens and rotating refresh tokens (TM-AUTH-02) | `apps/api/test/modules/auth/tokens/refresh.test.ts`                                                      | covered |
| V3.2    | Session binding                   | Tokens are bound to a device; a revoked device stops working on the next request (TM-AUTH-09)             | `apps/api/test/modules/auth/tokens/revocation.test.ts`                                                   | covered |
| V3.3    | Session termination               | Revocation ends the refresh family; refresh tokens slide for 30 days and end after 180                    | `apps/api/test/modules/auth/tokens/revocation.test.ts`                                                   | covered |
| V3.4    | Cookie-based session management   | The web sign-in flow sets cookies with the secure flags, `SameSite` and a PKCE state (TM-AUTH-07)         | `apps/api/test/modules/auth/pkce/web-cookie.test.ts`                                                     | covered |
| V3.5    | Token-based session management    | Access tokens are EdDSA only with checked `kid`, issuer, audience, type and skew (TM-AUTH-01)             | `apps/api/test/modules/auth/tokens/jwt.test.ts`                                                          | covered |
| V3.6    | Federated re-authentication       | Social linking only on a verified e-mail, with state binding on the callback (TM-AUTH-08)                 | `apps/api/test/modules/auth/social/linking.test.ts`, `apps/api/test/modules/auth/social/state.test.ts`   | covered |
| V3.7    | Defenses against session exploits | Open redirects blocked by an exact allow-list; CSRF handled by PKCE and state (TM-AUTH-06, -07)           | `apps/api/test/modules/auth/magic-link/redirect.test.ts`, `apps/api/test/modules/auth/pkce/pkce.test.ts` | covered |

## V4 Access control

| Section | Topic                  | Control                                                                                                                                           | Evidence                                                                                                                                | Status  |
| ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V4.1    | General access control | One RBAC engine; roles are read from the database; every route declares a scope and a coverage test fails for one that does not (TM-RBAC-01, -02) | `packages/core/test/rbac/matrix.test.ts`, `packages/core/test/rbac/coverage.test.ts`                                                    | covered |
| V4.2    | Operation-level access | Non-members get 404, never 403; role fuzzing over every role and action (TM-RBAC-01, -03); relay checks authority per frame (TM-RELAY-03)         | `apps/api/test/rbac-plugin.test.ts`, `packages/core/test/rbac/can.fuzz.test.ts`, `apps/relay/test/rooms/rooms.authorize.matrix.test.ts` | covered |
| V4.3    | Other access control   | The staff API has its own listener and an address allow-list, and no endpoint reads session content (TM-ADM-01, -02)                              | `apps/api/test/admin/admin.listener.test.ts`, `apps/api/test/admin/admin.routes.test.ts`                                                | covered |

## V5 Validation, sanitization and encoding

| Section | Topic                                    | Control                                                                                                                     | Evidence                                                       | Status  |
| ------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| V5.1    | Input validation                         | Every route validates against the contract schema; unknown fields and oversize bodies are refused (TM-API-02, TM-RELAY-08)  | `apps/api/test/error-handler.test.ts`, `apps/relay/test/codec` | covered |
| V5.2    | Sanitization and sandboxing              | Webhook payloads carry allow-listed fields only; outgoing URLs are resolved and range-checked at delivery (TM-HOOK-01, -03) | `apps/api/test/webhooks/webhooks.payload.contract.test.ts`     | covered |
| V5.3    | Output encoding and injection prevention | Queries are parameterised through the query builder; replies are JSON problem documents, not rendered HTML (TM-API-04)      | `apps/api/test/error-handler.test.ts`                          | covered |
| V5.4    | Memory, string and unmanaged code        | Not applicable: managed runtime (Node.js); no native code of our own                                                        | -                                                              | n/a     |
| V5.5    | Deserialization prevention               | Only JSON is parsed, through schemas; no object-graph or code-bearing formats are accepted                                  | `apps/relay/test/codec`                                        | covered |

## V6 Stored cryptography

| Section | Topic               | Control                                                                                                                            | Evidence                                                                                       | Status  |
| ------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| V6.1    | Data classification | Assets and where they live are listed in the threat model; the backend stores ciphertext only for work content (TM-DATA-02)        | `apps/api/test/history/history.privacy.test.ts`                                                | covered |
| V6.2    | Algorithms          | EdDSA tokens, HMAC-SHA256 webhook signatures, SHA-256 for stored codes; content encryption is the client's (CT-CRYPTO)             | `apps/api/test/modules/auth/tokens/jwt.test.ts`, `packages/core/test/webhooks/signing.test.ts` | covered |
| V6.3    | Random values       | Codes, tokens and ids come from the platform CSPRNG                                                                                | `apps/api/test/modules/auth/device/security.test.ts`                                           | partial |
| V6.4    | Secret management   | Secrets live in `production.env` (mode 600) or a secret manager, never in the repository; scanners in CI and as a hook (TM-OPS-03) | `infra/security/security.test.ts`, `infra/deploy/deploy.test.ts`                               | partial |

V6.3 and V6.4 are partial: there is no test that every token source uses the CSPRNG, and key rotation for
`AUTH_SIGNING_KEYS` is documented but has not been drilled.

## V7 Error handling and logging

| Section | Topic          | Control                                                                                                                                                      | Evidence                                                                                  | Status  |
| ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------- |
| V7.1    | Log content    | The access log records no headers or bodies; the credential-leak guard redacts every line (TM-API-05); relay logs are allow-listed fields only (TM-RELAY-04) | `apps/api/test/access-log.test.ts`, `apps/relay/test/privacy/privacy.logger.test.ts`      | covered |
| V7.2    | Log processing | Audit events for sign-ins, role changes, billing, admin reads and exports (TM-API-09)                                                                        | `apps/api/test/audit-api/audit.routes.test.ts`                                            | covered |
| V7.3    | Log protection | Logs are written to the container's output with no user-controlled line breaks; shipping and retention are the operator's                                    | `apps/api/test/access-log.test.ts`                                                        | partial |
| V7.4    | Error handling | One problem+json handler with a fixed message table; no stack traces or paths (TM-API-04); relay errors carry codes (TM-RELAY-06)                            | `apps/api/test/error-handler.test.ts`, `apps/relay/test/privacy/privacy.sanitize.test.ts` | covered |

## V8 Data protection

| Section | Topic                       | Control                                                                                                                                                                                                  | Evidence                                                                                                                                                | Status  |
| ------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V8.1    | General data protection     | History is read with a standing check on every request (TM-DATA-01)                                                                                                                                      | `apps/api/test/history/history.authz.test.ts`, `apps/api/test/security-headers.test.ts`                                                                 | covered |
| V8.2    | Client-side data protection | Not applicable: the backend ships no browser application that keeps data; the client has its own mapping                                                                                                 | -                                                                                                                                                       | n/a     |
| V8.3    | Sensitive private data      | Metrics and logs carry ids and codes only (TM-RELAY-05); card data is never stored (TM-BILL-07); deletion jobs purge data, **but a restored backup can bring a deleted account back** (TM-DATA-06, open) | `apps/relay/test/privacy/privacy.metrics.test.ts`, `apps/api/test/billing/webhooks/webhook.privacy.test.ts`, `apps/worker/test/workspace-purge.test.ts` | partial |

## V9 Communication

| Section | Topic                | Control                                                                                                                              | Evidence                      | Status  |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------- |
| V9.1    | Client communication | Caddy terminates TLS and redirects HTTP; Cloudflare in front in Full (strict) mode (TM-EDGE-01); only ports 80 and 443 are published | `infra/deploy/deploy.test.ts` | partial |
| V9.2    | Server communication | Internal services share one private network; calls out (Stripe, mail, object store) use HTTPS                                        | `infra/deploy/deploy.test.ts` | partial |

V9.1 and V9.2 are partial: no test scans the live TLS configuration (protocol versions, cipher suites). That is
on the pen-test checklist ([`pentest-scope.md`](pentest-scope.md)).

## V10 Malicious code

| Section | Topic                 | Control                                                                                                                                     | Evidence                                                                             | Status  |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- |
| V10.1   | Code integrity        | Exact dependency pins, install scripts never run, licence and advisory checks, SBOM (TM-OPS-02); signed release manifests (TM-REL-01)       | `infra/security/security.test.ts`, `apps/api/test/releases/releases.publish.test.ts` | covered |
| V10.2   | Malicious code search | Review of every change through the pipeline; no time bombs or back doors are searched for by tooling beyond the advisory and licence checks | `infra/security/security.test.ts`                                                    | partial |
| V10.3   | Application integrity | Images are built from the lockfile; the release-signing key is held by the release pipeline, not by this repository (TM-REL-02, accepted)   | `infra/deploy/deploy.test.ts`                                                        | partial |

## V11 Business logic

| Section | Topic                   | Control                                                                                                                                                                                                                                  | Evidence                                                                                                                                                                         | Status  |
| ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V11.1   | Business logic security | Idempotency on money and invite routes (TM-API-03); server-side prices and return URLs (TM-BILL-04); webhook ordering and de-duplication (TM-BILL-01, -02); usage attributed to the caller (TM-BILL-06); coupon rate limits (TM-BILL-05) | `apps/api/test/billing/checkout/checkout.idempotency.test.ts`, `apps/api/test/billing/webhooks/webhook.ordering.test.ts`, `apps/api/test/usage/ingest/usage.attribution.test.ts` | covered |

## V12 Files and resources

| Section | Topic           | Control                                                                                                                               | Evidence                                            | Status  |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------- |
| V12.1   | File upload     | The API accepts no file bodies. Snapshots go straight to the object store through pre-signed URLs with the length signed (TM-DATA-03) | `apps/api/test/snapshots/snapshots.presign.test.ts` | covered |
| V12.2   | File integrity  | Stored objects are ciphertext the server never opens, and the index keeps only sequence, ids, size and key id (no content column)     | `apps/api/test/history/history.privacy.test.ts`     | covered |
| V12.3   | File execution  | Not applicable: the backend never executes or serves uploaded files                                                                   | -                                                   | n/a     |
| V12.4   | File storage    | Buckets are private; backups are encrypted before upload (TM-DATA-07)                                                                 | `infra/dr/dr.test.ts`                               | covered |
| V12.5   | File download   | Downloads are pre-signed, short-lived and checked against standing (TM-DATA-03)                                                       | `apps/api/test/snapshots/snapshots.authz.test.ts`   | covered |
| V12.6   | SSRF protection | Outgoing webhook targets are resolved and refused in private, loopback and link-local ranges at delivery time (TM-HOOK-01)            | `apps/api/test/webhooks/webhooks.ssrf.test.ts`      | covered |

## V13 API and web service

| Section | Topic               | Control                                                                                                                   | Evidence                                                                      | Status  |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| V13.1   | Generic web service | Per-address and per-credential limits; body size limits at Caddy and in the API (TM-API-01, -02); one error shape         | `apps/api/test/rate-limit.test.ts`, `infra/deploy/deploy.test.ts`             | covered |
| V13.2   | RESTful web service | Methods and content types are fixed by the contract; CORS is exact-origin with no wildcard (TM-API-06); idempotent writes | `apps/api/test/security-headers.test.ts`, `apps/api/test/idempotency.test.ts` | covered |
| V13.3   | SOAP web service    | Not applicable: no SOAP or XML web services                                                                               | -                                                                             | n/a     |
| V13.4   | GraphQL             | Not applicable: there is no GraphQL endpoint                                                                              | -                                                                             | n/a     |

## V14 Configuration

| Section | Topic                          | Control                                                                                                                                 | Evidence                                                             | Status  |
| ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| V14.1   | Build and deploy               | Images built from the lockfile; deploy with a health-gated rollback; forward-only migrations with a backup first (TM-OPS-05)            | `infra/deploy/deploy.test.ts`                                        | covered |
| V14.2   | Dependency                     | Exact pins, advisory and licence checks, SBOM per service (TM-OPS-02)                                                                   | `infra/security/security.test.ts`                                    | covered |
| V14.3   | Unintended security disclosure | No stack traces, versions or hosts in errors (TM-API-04); admin and metrics paths answer 404 on the public host (TM-ADM-01)             | `apps/api/test/error-handler.test.ts`, `infra/deploy/deploy.test.ts` | covered |
| V14.4   | HTTP security headers          | Security headers on every reply (TM-API-06)                                                                                             | `apps/api/test/security-headers.test.ts`                             | covered |
| V14.5   | HTTP request header validation | The client address is taken from the right end of `X-Forwarded-For` with a fixed proxy count (TM-EDGE-02); hosts are fixed by the proxy | `packages/core/test/ratelimit/client-ip.test.ts`                     | covered |
