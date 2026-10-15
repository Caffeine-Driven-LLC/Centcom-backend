# Threat model and penetration-test preparation

Lane B098. What we protect, from whom, where the trust boundaries are, which controls exist and what proves them,
what is knowingly open, and how an outside tester should approach the system. The tables in this file are
checked by `pnpm pentest:check` (ids are unique and well formed, every owner lane exists, every evidence path
exists), so a renamed test breaks the check instead of rotting here.

The scope is the **backend** (API, relay, worker, admin listener, billing, webhooks, data stores, deploy and
backup scripts). The client has its own threat model; here the client is an untrusted peer and the end-to-end
encryption design ([CT-CRYPTO](../../contracts/05-crypto.md)) is an input: the backend must never see plaintext
work content.

## Assets

| Asset                                                                             | Why it matters                                                         | Where it lives                                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Account credentials: sessions, refresh tokens, device keys, API keys, magic links | Control of a person's workspaces and billing                           | Postgres (hashed or public keys only), Redis (short-lived), browser cookies |
| Token signing keys (`AUTH_SIGNING_KEYS`)                                          | Anyone holding one can mint any identity                               | `production.env` on the server only; API and worker                         |
| Ciphertext history and snapshots                                                  | Confidential work content, protected by keys the backend does not hold | Object store (MinIO/R2/S3), `history_*` tables                              |
| Entitlement and billing state                                                     | Free use of paid plans, or loss of a paying customer's access          | Postgres (`workspace_entitlements`, `billing_*`)                            |
| Member metadata                                                                   | Names, e-mail addresses, who works with whom, presence                 | Postgres                                                                    |
| Webhook secrets, Stripe keys, mail keys                                           | Forged events, spend, impersonated mail                                | `production.env`, `webhook_endpoints` (encrypted)                           |
| Release manifests                                                                 | A tampered manifest pushes malware through the auto-updater            | Postgres, served by the API; artifacts on a CDN                             |
| Backups                                                                           | A full copy of everything above                                        | Encrypted (`BACKUP_PASSPHRASE`) to an S3 bucket                             |

## Actors

Anonymous visitor; free user; paid member; malicious member (viewer, editor, host of a command post);
workspace admin or owner; Centcom staff (admin listener); compromised device (stolen laptop with a valid
refresh token); malicious host of a shared session; network attacker; malicious webhook receiver; malicious
script on a customer's machine calling the public API; a compromised dependency or CI runner.

## Trust boundaries and data flows

Trust boundaries are drawn as the dashed `untrusted | ours` lines. Only Caddy publishes ports; the admin
listener is on the private network only.

### 1. Device login (RFC 8628)

```mermaid
flowchart LR
  subgraph untrusted
    T[Terminal]
    B[Browser]
  end
  subgraph edge[Cloudflare and Caddy]
    E[TLS, WAF, body limits]
  end
  subgraph ours
    A[API]
    R[(Redis codes)]
    P[(Postgres)]
    M[Mail provider]
  end
  T -->|POST /v1/auth/device/code| E --> A
  A --> R
  B -->|/device user code and email login| E --> A
  A -->|magic link via queue| M
  A --> P
  T -->|poll /v1/auth/token| E --> A
```

### 2. Relay join and handshake

```mermaid
flowchart LR
  subgraph untrusted
    C[Client]
  end
  subgraph ours
    A[API: join-token]
    L[Relay]
    R[(Redis)]
    P[(Postgres)]
  end
  C -->|REST: join-token, scope and RBAC checked| A
  A -->|short-lived relay ticket, EdDSA| C
  C -->|WSS + ticket| L
  L -->|verify against JWKS, live membership| P
  L --> R
```

### 3. Command-post queue approval

```mermaid
flowchart LR
  subgraph untrusted
    G[Guest or editor]
    H[Host]
  end
  subgraph ours
    L[Relay queue and approval service]
    P[(Postgres)]
  end
  G -->|queue.submit| L
  H -->|queue.approve, signed by host role only| L
  L -->|authority check per frame| P
  L -->|ciphertext fan-out only| H
```

### 4. History and snapshot access

```mermaid
flowchart LR
  subgraph untrusted
    C[Member or ex-member]
  end
  subgraph ours
    A[API: history, snapshots]
    P[(Postgres: standing, index)]
    S[(Object store: ciphertext)]
  end
  C -->|GET history, token + RBAC + live standing| A
  A --> P
  A -->|reads ciphertext blobs| S
  C -.->|pre-signed URL, short expiry| S
```

### 5. Billing webhook to entitlement flip

```mermaid
flowchart LR
  subgraph untrusted
    X[Anyone on the internet]
  end
  subgraph third[Stripe]
    ST[Stripe]
  end
  subgraph ours
    A[API: /internal/stripe/webhook]
    P[(Postgres: stripe_event)]
    W[Worker: process event]
    EN[Entitlements]
  end
  ST -->|signed event| A
  X -.->|forged event: rejected| A
  A -->|verify HMAC on raw bytes, store once| P
  W -->|re-fetch subscription from Stripe API| ST
  W --> EN
```

### 6. Outgoing webhook delivery

```mermaid
flowchart LR
  subgraph ours
    E[Event emitter] --> Q[(Redis queue)] --> D[Deliverer]
  end
  subgraph untrusted
    U[Customer endpoint URL]
  end
  D -->|HMAC-signed POST, SSRF-checked address, timeout| U
```

## STRIDE by component

Columns: id, STRIDE letter (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service,
Elevation of privilege), threat, control, owner lane, evidence (tests or scripts that prove it), status
(`mitigated`, `accepted`, `open`).

### API: sign-in and tokens

| ID         | S   | Threat                                                                                       | Control                                                                                                                                                                                      | Owner | Evidence                                                                                                          | Status    |
| ---------- | --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- | --------- |
| TM-AUTH-01 | S   | Attacker forges an access token (algorithm confusion, `none`, wrong key)                     | EdDSA only, `kid` must name a published key, issuer, audience and `typ` checked, 60 s skew                                                                                                   | B017  | `apps/api/test/modules/auth/tokens/jwt.test.ts`, `apps/api/test/modules/auth/tokens/jwks.test.ts`                 | mitigated |
| TM-AUTH-02 | S   | Stolen refresh token replayed                                                                | Rotation with reuse detection: a reused token revokes the family                                                                                                                             | B017  | `apps/api/test/modules/auth/tokens/refresh.test.ts`, `apps/api/test/modules/auth/tokens/revocation.test.ts`       | mitigated |
| TM-AUTH-03 | S   | Guess a device `user_code` or poll with a stolen `device_code`                               | Codes stored only as SHA-256; a user is locked out for 15 minutes after 10 wrong tries in 10 minutes (and an address likewise); unknown, expired, used and foreign codes all answer the same | B016  | `apps/api/test/modules/auth/device/security.test.ts`, `apps/api/test/modules/auth/device/rfc8628.test.ts`         | mitigated |
| TM-AUTH-04 | I   | Account enumeration through the sign-in form                                                 | Same response and timing class whether or not the address has an account                                                                                                                     | B014  | `apps/api/test/modules/auth/magic-link/enumeration.test.ts`                                                       | mitigated |
| TM-AUTH-05 | S   | Mail scanner or link prefetch consumes a one-time sign-in link; link used in another browser | GET shows a confirm form and changes nothing, however often; only the POST consumes the link                                                                                                 | B014  | `apps/api/test/modules/auth/magic-link/prefetch.test.ts`, `apps/api/test/modules/auth/magic-link/service.test.ts` | mitigated |
| TM-AUTH-06 | S   | Open redirect through `return_to` after login                                                | Exact-match allow-list (`LOGIN_RETURN_TO_ALLOWLIST`)                                                                                                                                         | B014  | `apps/api/test/modules/auth/magic-link/redirect.test.ts`, `apps/api/test/modules/auth/social/redirect.test.ts`    | mitigated |
| TM-AUTH-07 | T   | Login CSRF and authorization-code interception on the web flow                               | PKCE (S256), `state`, single-use codes, cookie flags                                                                                                                                         | B018  | `apps/api/test/modules/auth/pkce/pkce.test.ts`, `apps/api/test/modules/auth/pkce/web-cookie.test.ts`              | mitigated |
| TM-AUTH-08 | E   | Account takeover by linking a social identity with an unverified e-mail                      | Linking only on `email_verified`; state binding on the provider callback                                                                                                                     | B015  | `apps/api/test/modules/auth/social/linking.test.ts`, `apps/api/test/modules/auth/social/state.test.ts`            | mitigated |
| TM-AUTH-09 | R   | A revoked device keeps working until the token expires                                       | Revocation list checked on every request; access tokens live 15 minutes                                                                                                                      | B017  | `apps/api/test/modules/auth/tokens/revocation.test.ts`                                                            | mitigated |
| TM-AUTH-10 | D   | Mail bombing a victim through the sign-in form                                               | Per-address and per-client limits, 5 mails per address and template per hour                                                                                                                 | B014  | `apps/api/test/modules/auth/magic-link/limits.test.ts`, `packages/core/test/email/service.test.ts`                | mitigated |
| TM-AUTH-11 | E   | API key leaked in a log or repository gives silent access                                    | Keys hashed at rest, shown once, scoped, revocable; secret scanner in CI and as a pre-commit hook                                                                                            | B019  | `apps/api/test/modules/apikeys`, `infra/security/security.test.ts`                                                | mitigated |

### API: authorization, limits, errors

| ID         | S   | Threat                                                      | Control                                                                                                                                                                                                                                                                                                                                                           | Owner | Evidence                                                                                                                             | Status    |
| ---------- | --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| TM-RBAC-01 | E   | Member reaches another workspace's data by guessing ids     | One RBAC engine; roles read from the database; unknown and forbidden both answer 404 for non-members                                                                                                                                                                                                                                                              | B021  | `packages/core/test/rbac/matrix.test.ts`, `apps/api/test/rbac-plugin.test.ts`                                                        | mitigated |
| TM-RBAC-02 | E   | A token's scopes are wider than the route needs             | Every route declares its scope; a coverage test fails for a route without one                                                                                                                                                                                                                                                                                     | B021  | `packages/core/test/rbac/coverage.test.ts`, `packages/core/test/rbac/scopes.test.ts`                                                 | mitigated |
| TM-RBAC-03 | E   | Role fuzzing finds a permission the matrix does not grant   | Property tests over every role and action                                                                                                                                                                                                                                                                                                                         | B021  | `packages/core/test/rbac/can.fuzz.test.ts`                                                                                           | mitigated |
| TM-API-01  | D   | Request flood or one client exhausting capacity             | Redis-backed limits per address and credential, buckets per route class, edge limits at Cloudflare                                                                                                                                                                                                                                                                | B023  | `packages/core/test/ratelimit/buckets.test.ts`, `apps/api/test/rate-limit.test.ts`                                                   | mitigated |
| TM-API-02  | D   | Oversized bodies                                            | 256 KiB default, 1 MiB on batch routes, enforced by Caddy and by the API                                                                                                                                                                                                                                                                                          | B097  | `infra/deploy/deploy.test.ts`, `apps/api/test/telemetry/telemetry.routes.test.ts`                                                    | mitigated |
| TM-API-03  | T   | A retried request runs twice (double charge, double invite) | `Idempotency-Key` middleware: required on money and invite routes, stored replies encrypted                                                                                                                                                                                                                                                                       | B024  | `apps/api/test/idempotency.test.ts`, `apps/api/test/billing/checkout/checkout.idempotency.test.ts`                                   | mitigated |
| TM-API-04  | I   | Stack traces, SQL or paths in error bodies                  | Central problem+json handler with a fixed message table                                                                                                                                                                                                                                                                                                           | B006  | `apps/api/test/error-handler.test.ts`                                                                                                | mitigated |
| TM-API-05  | I   | Tokens, bodies or provider credentials in logs              | The access log records no headers or bodies. Every line the API and the worker write passes the B101 scanner (`createContext` wraps the logger), as do the relay's (`startRelay`): a provider credential becomes `[redacted:<pattern>]` and is counted. Scope: provider credentials (Anthropic, OpenAI, AWS, Google keys, bearer lines), not Centcom's own tokens | B101  | `apps/api/test/access-log.test.ts`, `apps/api/test/secret-guard/mounts.test.ts`, `apps/relay/test/secret-guard/secret-guard.test.ts` | mitigated |
| TM-API-06  | T   | Clickjacking, MIME sniffing, cross-origin reads             | Security headers on every reply; exact-origin CORS, no wildcard                                                                                                                                                                                                                                                                                                   | B097  | `apps/api/test/security-headers.test.ts`                                                                                             | mitigated |
| TM-API-07  | D   | Redis outage turns into an outage of everything             | Degrade policy: reads fail open slowly, required-idempotency routes fail closed with 503                                                                                                                                                                                                                                                                          | B096  | `apps/api/test/chaos/chaos.api.test.ts`                                                                                              | mitigated |
| TM-API-08  | D   | Postgres outage returns success for lost writes             | 503 + `Retry-After`; write ledger proves no acknowledged write is lost, also across a SIGKILL                                                                                                                                                                                                                                                                     | B096  | `apps/api/test/chaos/chaos.crash.test.ts`                                                                                            | mitigated |
| TM-API-09  | R   | A privileged action has no trail                            | Audit events for sign-ins, role changes, billing, admin reads, exports                                                                                                                                                                                                                                                                                            | B036  | `apps/api/test/audit-api/audit.routes.test.ts`                                                                                       | mitigated |

### Relay

| ID          | S   | Threat                                                   | Control                                                                                                                                                      | Owner | Evidence                                                                                                                                                                | Status    |
| ----------- | --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| TM-RELAY-01 | S   | Replay or reuse of a relay ticket                        | EdDSA ticket valid 60 s (60 s skew, no more), verified against the JWKS; `alg: none`, an HS256 downgrade and keys carried in `jwk`/`jku` headers are refused | B038  | `apps/relay/test/handshake/handshake.ticket.test.ts`, `apps/relay/test/handshake/handshake.jwks.test.ts`                                                                | mitigated |
| TM-RELAY-02 | E   | Join a session without membership or after removal       | Live membership re-read at the handshake and every 2 s; kicked members are dropped                                                                           | B043  | `apps/relay/test/handshake/handshake.access.test.ts`, `apps/relay/test/rooms/rooms.membership-live.test.ts`                                                             | mitigated |
| TM-RELAY-03 | E   | An editor sends `queue.approve` or control commands      | Authority checked per frame against the sender's session role                                                                                                | B051  | `apps/relay/test/control/control.authority.test.ts`, `apps/relay/test/queue/queue.policy.test.ts`, `apps/relay/test/rooms/rooms.authorize.matrix.test.ts`               | mitigated |
| TM-RELAY-04 | I   | **Plaintext leak: log lines**                            | Allow-listed log fields only, AST scan of every `logger` call                                                                                                | B050  | `apps/relay/test/privacy/privacy.logger.test.ts`, `apps/relay/test/privacy/privacy.architecture.test.ts`                                                                | mitigated |
| TM-RELAY-05 | I   | **Plaintext leak: metrics labels**                       | Fixed label sets; canary values never appear in metrics output                                                                                               | B050  | `apps/relay/test/privacy/privacy.metrics.test.ts`, `apps/relay/test/privacy/privacy.canary.test.ts`                                                                     | mitigated |
| TM-RELAY-06 | I   | **Plaintext leak: error messages and close reasons**     | Errors carry codes only; sanitiser strips payload text                                                                                                       | B050  | `apps/relay/test/privacy/privacy.sanitize.test.ts`                                                                                                                      | mitigated |
| TM-RELAY-07 | I   | **Plaintext leak: debug endpoints and dumps**            | No endpoint returns frames; the architecture test forbids reading `ct` outside the codec and store                                                           | B050  | `apps/relay/test/privacy/privacy.architecture.test.ts`, `apps/relay/test/privacy/privacy.vectors.test.ts`                                                               | mitigated |
| TM-RELAY-08 | T   | Malformed or oversized frames crash or confuse the relay | Schema-enforced codec with size limits, fuzzing                                                                                                              | B039  | `apps/relay/test/codec`                                                                                                                                                 | mitigated |
| TM-RELAY-09 | D   | Slow consumer or flood exhausts memory                   | Per-connection watermarks, ephemeral drop, node guard, connection cap                                                                                        | B046  | `apps/relay/test/backpressure/backpressure.watermarks.test.ts`, `apps/relay/test/backpressure/backpressure.isolation.test.ts`, `apps/relay/test/relay.capacity.test.ts` | mitigated |
| TM-RELAY-10 | T   | Frames lost or reordered on reconnect                    | Per-session sequencing, resume from hot buffer or durable log; relay restart under load shows no gap                                                         | B041  | `apps/relay/test/resume/resume.replay.test.ts`, `apps/api/test/chaos/chaos.relay.test.ts`                                                                               | mitigated |
| TM-RELAY-11 | T   | Key-grant or epoch messages manipulated                  | Opaque grants routed only to named devices; stale `kid` refused                                                                                              | B049  | `apps/relay/test/keys/keys.grant-validation.test.ts`, `apps/relay/test/keys/keys.stale-kid.test.ts`                                                                     | mitigated |
| TM-RELAY-12 | D   | Cursor and typing floods                                 | Throttled, unsequenced, size-capped                                                                                                                          | B048  | `apps/relay/test/cursors/cursors.throttle.test.ts`                                                                                                                      | mitigated |

### History, snapshots, share links

| ID         | S   | Threat                                           | Control                                                                                                                          | Owner | Evidence                                                                                                     | Status    |
| ---------- | --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ | --------- |
| TM-DATA-01 | I   | An ex-member reads history after removal         | Standing checked on every read, not at join time                                                                                 | B055  | `apps/api/test/history/history.authz.test.ts`                                                                | mitigated |
| TM-DATA-02 | I   | The backend stores or returns plaintext          | Only ciphertext frames are accepted; privacy tests plant canaries                                                                | B055  | `apps/api/test/history/history.privacy.test.ts`, `apps/api/test/snapshots/snapshots.privacy.test.ts`         | mitigated |
| TM-DATA-03 | I   | A pre-signed snapshot URL leaks or is reused     | Uploads are pre-signed with the declared length signed (another length gives another signature); the store refuses anything else | B056  | `apps/api/test/snapshots/snapshots.presign.test.ts`, `apps/api/test/snapshots/snapshots.authz.test.ts`       | mitigated |
| TM-DATA-04 | S   | A guest link is guessed or kept after revocation | Join limits per address (10 a minute), per token (30 a minute) and 20 links per user a minute; guest tickets are viewer-only     | B068  | `apps/api/test/share-links/share-links.join.test.ts`, `apps/api/test/share-links/share-links.limits.test.ts` | mitigated |
| TM-DATA-05 | E   | A viewer guest writes or approves                | Guest tokens are viewer-only by role                                                                                             | B068  | `apps/api/test/share-links/share-links.create-revoke.test.ts`                                                | mitigated |
| TM-DATA-06 | I   | Deleted data survives in a restore               | Purge jobs; **backups are not re-purged**: a restore can bring a deleted account back                                            | B090  | `apps/worker/test/workspace-purge.test.ts`                                                                   | open      |
| TM-DATA-07 | I   | Backups read by whoever finds the bucket         | Encrypted before upload with `BACKUP_PASSPHRASE`, which is kept off the server                                                   | B099  | `infra/dr/dr.test.ts`                                                                                        | mitigated |

### Billing

| ID         | S   | Threat                                                     | Control                                                                                                        | Owner | Evidence                                                                                                                       | Status    |
| ---------- | --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| TM-BILL-01 | S   | Forged Stripe webhook flips a plan                         | HMAC-SHA256 on the raw bytes, constant-time compare, 300 s tolerance; the worker re-fetches from Stripe        | B072  | `apps/api/test/billing/webhooks/webhook.signature.test.ts`, `apps/api/test/entrypoint/billing.e2e.test.ts`                     | mitigated |
| TM-BILL-02 | T   | Duplicate or out-of-order events leave the wrong plan      | Stored once per event id; stale-event guard on `created`; convergence test over shuffled events                | B072  | `apps/api/test/billing/webhooks/webhook.idempotency.test.ts`, `apps/api/test/billing/webhooks/webhook.ordering.test.ts`        | mitigated |
| TM-BILL-03 | E   | A member buys or manages billing for a workspace           | Only owner and billing roles; `billing:write` scope                                                            | B071  | `apps/api/test/billing/checkout/checkout.authz.test.ts`                                                                        | mitigated |
| TM-BILL-04 | T   | Client chooses the price or the return URL                 | Prices from the server catalogue; success and cancel URLs from configuration only                              | B071  | `apps/api/test/billing/checkout/checkout.redirects.test.ts`, `apps/api/test/billing/checkout/checkout.validation.test.ts`      | mitigated |
| TM-BILL-05 | E   | Coupon code brute force                                    | Rate limit and generic failure                                                                                 | B079  | `apps/api/test/billing/promotions/promotions.ratelimit.test.ts`, `apps/api/test/billing/promotions/promotions.invalid.test.ts` | mitigated |
| TM-BILL-06 | T   | Usage events inflated to dodge quotas or inflate another's | Events attributed to the device's own user and workspace; batch limits; idempotent                             | B074  | `apps/api/test/usage/ingest/usage.attribution.test.ts`, `apps/api/test/usage/ingest/usage.idempotency-rate.test.ts`            | mitigated |
| TM-BILL-07 | I   | Card data, e-mail or Stripe ids stored or logged           | Only ids and state are stored; the subscription route never returns a Stripe id                                | B070  | `apps/api/test/billing/webhooks/webhook.privacy.test.ts`                                                                       | mitigated |
| TM-BILL-08 | T   | Dunning and trial emails are not driven in the API process | Entitlements derive `past_due` and the grace date from Stripe's status, but no reminder or automatic drop runs | B078  | `docs/billing/going-live.md`                                                                                                   | open      |

### Outgoing webhooks, telemetry, releases

| ID         | S   | Threat                                                                      | Control                                                                                                        | Owner | Evidence                                                                                              | Status    |
| ---------- | --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- | --------- |
| TM-HOOK-01 | E   | SSRF: an endpoint URL points at the metadata service or the private network | Resolved addresses checked against private, loopback and link-local ranges at delivery time                    | B081  | `apps/api/test/webhooks/webhooks.ssrf.test.ts`                                                        | mitigated |
| TM-HOOK-02 | S   | Receivers cannot tell a real delivery from a forged one                     | HMAC-SHA256 signature with timestamp, per-endpoint secret                                                      | B081  | `packages/core/test/webhooks/signing.test.ts`                                                         | mitigated |
| TM-HOOK-03 | I   | Event data carries content                                                  | Per-type allow-list of fields; others refused at emit time                                                     | B081  | `apps/api/test/webhooks/webhooks.payload.contract.test.ts`                                            | mitigated |
| TM-HOOK-04 | D   | A slow or hostile receiver ties up workers                                  | Timeouts, retry schedule, dead-letter queue                                                                    | B081  | `apps/api/test/webhooks/webhooks.delivery.test.ts`                                                    | mitigated |
| TM-TELE-01 | I   | Telemetry deanonymises a person                                             | Allow-listed props, no credential read, install id only, always 204                                            | B085  | `apps/api/test/telemetry/telemetry.routes.test.ts`, `apps/api/test/telemetry/telemetry.units.test.ts` | mitigated |
| TM-REL-01  | T   | Release manifest downgrade or tampering                                     | Signed manifests (signature check at publish), `min_client_version`, yanking; artifacts verified by the client | B084  | `apps/api/test/releases/releases.publish.test.ts`                                                     | mitigated |
| TM-REL-02  | E   | The release-signing key is stolen                                           | Key is held by the release pipeline, not by this repo or server                                                | B084  | -                                                                                                     | accepted  |

### Admin, staff, edge, deploy

| ID         | S   | Threat                                                                            | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Owner | Evidence                                                                                                                                                                                                       | Status    |
| ---------- | --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| TM-ADM-01  | E   | The staff API is reachable from the internet                                      | Own listener, CIDR allow-list, dropped at connect; Caddy answers 404 for `/internal/admin/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | B087  | `apps/api/test/admin/admin.listener.test.ts`, `infra/deploy/deploy.test.ts`                                                                                                                                    | mitigated |
| TM-ADM-02  | I   | Staff reads session content or impersonates a user                                | No such endpoints exist; every call, reads included, is audited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | B087  | `apps/api/test/admin/admin.routes.test.ts`                                                                                                                                                                     | mitigated |
| TM-EDGE-01 | D   | Volumetric attack on the origin                                                   | Cloudflare in front (proxied records, Full strict), WAF module, per-address limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | B097  | `infra/terraform/modules/waf`                                                                                                                                                                                  | accepted  |
| TM-EDGE-02 | S   | Client address spoofed through `X-Forwarded-For`                                  | `TRUSTED_PROXY_HOPS` counts proxies; client IP taken from the right end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | B023  | `packages/core/test/ratelimit/client-ip.test.ts`                                                                                                                                                               | mitigated |
| TM-OPS-01  | E   | A container escape or a compromised service reaches the others                    | Non-root, read-only root, all capabilities dropped, per-service secrets only, one private network                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | B091  | `infra/deploy/deploy.test.ts`                                                                                                                                                                                  | mitigated |
| TM-OPS-02  | T   | A malicious dependency or install script                                          | Exact pins, install scripts never run, allow-list, licence and advisory checks, SBOM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | B097  | `infra/security/security.test.ts`                                                                                                                                                                              | mitigated |
| TM-OPS-03  | I   | Provider credentials in the repository, in requests, frames, telemetry or backups | Repository: scanner (CI + hook) and gitleaks rules. Runtime, mounted: REST hook on every API route (query, path, body, headers except Authorization; 400 `invalid_request`, one body for all patterns; the telemetry route is left to its ingest, which drops the event and answers 204); relay stage 31 on the clear parts of a frame (never `ct` or `sig`; `sys.error invalid_frame`); telemetry events; `backup.sh` scans the dump before encryption and uploads nothing on a hit (exit 6), `restore.sh` scans before `pg_restore`. Not covered: Centcom's own secrets, and `BACKUP_SCAN=skip` turns the backup scan off (the manifest says so) | B101  | `infra/security/security.test.ts`, `apps/api/test/secret-guard/mounts.test.ts`, `apps/api/test/secret-guard/scan-stream.test.ts`, `apps/relay/test/secret-guard/secret-guard.test.ts`, `infra/dr/scan.test.ts` | mitigated |
| TM-OPS-04  | D   | Single server: a reboot or a disk loss is an outage                               | Restart policy, health-gated deploy with rollback, tested restore (26 h worst-case data loss without WAL archiving)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | B099  | `infra/dr/dr.test.ts`, `infra/deploy/deploy.test.ts`                                                                                                                                                           | accepted  |
| TM-OPS-05  | T   | A bad migration corrupts data                                                     | Forward-only, backward-compatible migrations; backup before migrating; contract migrations need a flag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | B092  | `infra/deploy/deploy.test.ts`                                                                                                                                                                                  | mitigated |
| TM-OPS-06  | S   | Mail from our domain is forged                                                    | SPF, DKIM and DMARC at the domain (a human step; see `docs/ops/mail.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | B032  | `docs/ops/mail.md`                                                                                                                                                                                             | open      |

## Abuse cases

Each case names the request and the response the system must give. "Evidence" paths are tests that exercise
the same case; where a case has none, it is a **manual test for the pen-test**.

| #   | Contract / area | Abuse case                                                                               | Expected response                                                                            | Evidence                                                        |
| --- | --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | CT-AUTH         | Present a refresh token twice                                                            | 400 `invalid_grant`, the whole family is revoked                                             | `apps/api/test/modules/auth/tokens/refresh.test.ts`             |
| 2   | CT-AUTH         | Use an access token signed with `alg: none`, or `HS256` with the public key              | 401 `token_invalid`                                                                          | `apps/api/test/modules/auth/tokens/jwt.test.ts`                 |
| 3   | CT-AUTH         | Try many wrong user codes against `/device`                                              | Generic failure; locked out for 15 minutes after 10 tries in 10 minutes                      | `apps/api/test/modules/auth/device/security.test.ts`            |
| 4   | CT-AUTH         | Open `/login/email/verify?t=` from a scanner, then from the real browser                 | Scanner sees a page and consumes nothing; the browser signs in                               | `apps/api/test/modules/auth/magic-link/prefetch.test.ts`        |
| 5   | CT-AUTH         | Ask for a sign-in link for an unknown address and a known one                            | Identical answer                                                                             | `apps/api/test/modules/auth/magic-link/enumeration.test.ts`     |
| 6   | CT-RBAC         | A `member` calls an `admin` route; a token without the scope calls it                    | 403 `forbidden`                                                                              | `packages/core/test/rbac/matrix.test.ts`                        |
| 7   | CT-RBAC         | Read `/v1/workspaces/{id}/members` of a workspace you are not in, with a guessed id      | 404 `not_found` (never 403, so existence is hidden)                                          | `apps/api/test/rbac-plugin.test.ts`                             |
| 8   | CT-WS-ENVELOPE  | Send a frame with an unknown type, a 10 MiB `ct`, or invalid UTF-8                       | Frame refused with the registry error; unknown types tolerated (acked, ignored) per contract | `apps/relay/test/codec`                                         |
| 9   | CT-WS-ENVELOPE  | Reuse a relay ticket on a second connection or after expiry                              | Handshake refused                                                                            | `apps/relay/test/handshake/handshake.ticket.test.ts`            |
| 10  | CT-WS-QUEUE     | An editor sends `queue.approve`                                                          | Refused, nothing changes, audit event                                                        | `apps/relay/test/queue/queue.policy.test.ts`                    |
| 11  | CT-WS-QUEUE     | Submit the same item twice with one client id                                            | Deduped to one                                                                               | `apps/relay/test/queue/queue.idempotency.test.ts`               |
| 12  | CT-WS-CONTROL   | A kicked member keeps sending on the old connection                                      | Connection dropped within the 2 s membership refresh                                         | `apps/relay/test/control/control.kick-rotate.test.ts`           |
| 13  | CT-WS-CONTROL   | A non-host calls `end` or `transfer`                                                     | Refused                                                                                      | `apps/relay/test/control/control.transfer-end.test.ts`          |
| 14  | CT-RESUME       | Resume from a `seq` far in the past or the future                                        | Replay from the log, or `snapshot required`; never other sessions' frames                    | `apps/relay/test/resume/resume.snapshot-required.test.ts`       |
| 15  | CT-RESUME       | Resume into a session you were removed from                                              | Refused at the handshake                                                                     | `apps/relay/test/handshake/handshake.access.test.ts`            |
| 16  | CT-API-SESSIONS | Request a join token for a session of another workspace                                  | 404                                                                                          | `apps/api/test/routes/sessions`                                 |
| 17  | CT-API-SESSIONS | Hammer the share-link join route from one address                                        | The 11th join in a minute is 429 with `Retry-After`                                          | `apps/api/test/share-links/share-links.limits.test.ts`          |
| 18  | CT-API-SESSIONS | Read history of a session after being kicked                                             | 403/404                                                                                      | `apps/api/test/history/history.authz.test.ts`                   |
| 19  | CT-API-SESSIONS | Upload a snapshot of another size than the one declared in the pre-signed request        | The object store refuses (length is part of the signature)                                   | `apps/api/test/snapshots/snapshots.presign.test.ts`             |
| 20  | CT-API-BILLING  | Post a Stripe event with a bad, stale or missing signature                               | 400, nothing stored                                                                          | `apps/api/test/entrypoint/billing.e2e.test.ts`                  |
| 21  | CT-API-BILLING  | Checkout with `success_url=https://evil` or a price the catalogue does not sell          | URL ignored; 422 for the price                                                               | `apps/api/test/billing/checkout/checkout.redirects.test.ts`     |
| 22  | CT-API-BILLING  | Redeem coupon codes in a loop                                                            | Generic failure, then 429                                                                    | `apps/api/test/billing/promotions/promotions.ratelimit.test.ts` |
| 23  | CT-API-BILLING  | Replay a checkout request with the same `Idempotency-Key` but another body               | 409 `idempotency_conflict`                                                                   | `apps/api/test/billing/checkout/checkout.idempotency.test.ts`   |
| 24  | CT-API-USAGE    | Submit usage for a workspace you are not in; submit 100 000 events in one batch          | Attributed to your own device only; 413/422                                                  | `apps/api/test/usage/ingest/usage.attribution.test.ts`          |
| 25  | CT-API-WEBHOOKS | Register an endpoint at `http://169.254.169.254/` or a DNS name that resolves to it      | Refused at registration or blocked at delivery                                               | `apps/api/test/webhooks/webhooks.ssrf.test.ts`                  |
| 26  | CT-API-WEBHOOKS | Read another workspace's endpoints or deliveries                                         | 404                                                                                          | `apps/api/test/webhooks/webhooks.routes.test.ts`                |
| 27  | CT-TELEMETRY    | Post telemetry with props outside the allow-list, or with a bearer token                 | 204; unknown props dropped; token ignored                                                    | `apps/api/test/telemetry/telemetry.routes.test.ts`              |
| 28  | CT-API-RELEASES | Request `/v1/releases/stable/latest` with odd `platform` values; look for a yanked build | 400 for bad values; yanked never served                                                      | `apps/api/test/releases/releases.routes.test.ts`                |
| 29  | Edge            | Request `/internal/admin/v1/users` and `/metrics` through the public host                | 404 from Caddy                                                                               | `infra/deploy/deploy.test.ts`                                   |
| 30  | Edge            | Send a 5 MiB body to `/v1/telemetry/events`                                              | 413 (Caddy) / 204 (API, by contract: never an error body)                                    | `infra/deploy/deploy.test.ts`                                   |

## Penetration-test preparation

**Status: not run.** No test has been performed and no vendor engaged. This section is what to hand a tester.

### Scope

| In scope                                                                                                                                                                | Out of scope                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A dedicated **pen-test environment** deployed from `infra/deploy` (API, relay, worker, Caddy) with its own hostnames, Stripe **test mode**, and a throwaway mail domain | Production hosts and production data stores                                                      |
| The public REST API, the device and login pages, the WebSocket relay, the Stripe webhook endpoint, the outgoing webhook deliverer (receiver URLs the tester controls)   | Stripe, Resend/Brevo/Postmark, Cloudflare, the CDN and GitHub themselves (third-party providers) |
| The admin listener, **from inside the allow-listed CIDR the tester is given**                                                                                           | Denial-of-service beyond the rate below; social engineering of staff; physical access            |
| The deploy scripts and the container images (read access to the repository is given)                                                                                    | The client application (own threat model)                                                        |

### Rules of engagement

- At most **50 requests per second sustained per tester address**; announce any burst test in advance.
- Use only the provided test accounts and workspaces; never try to read other customers' data. Stop and report
  at once if real personal data or a real credential is found.
- Stripe test mode only (cards `4242 4242 4242 4242` and Stripe's documented failure cards).
- No destructive tests against the database or object store; the environment can be rebuilt with
  `deploy.sh` and restored from a backup, but tell us before you try.
- Report within 24 hours for critical findings; findings go to the address in the disclosure policy (a
  `security.txt` and a disclosure policy page are web-side work and are **not** produced yet).

### Test accounts to prepare (a seed script is not written yet)

One user per workspace role (owner, admin, billing, member, guest) and per session role (host, editor, viewer),
workspaces on free, pro and team, two sessions with synthetic ciphertext. Until `pnpm pentest:seed` exists,
create them by hand against the pen-test environment with `SELF_HOST_PLAN` unset and the Stripe test keys.

### Severity

CVSS v4 base score, then a local override: anything that exposes plaintext work content, mints an identity, or
changes another customer's plan is **critical** regardless of score.

### Checklist for the tester (and for us before the test)

1. [ ] Every row of the tables above is `mitigated`, `accepted` with a reason, or open with an issue.
2. [ ] `pnpm pentest:check` passes; `pnpm chaos` passes; `pnpm security:deps`, `security:secrets` pass.
3. [ ] The environment runs the release candidate (`SERVICE_VERSION` visible in `/v1/status`), with the WAF module applied.
4. [ ] Authentication: tokens (alg, kid, aud, skew, revocation), device flow limits, magic-link prefetch and
       enumeration, PKCE and `return_to`, social linking, API keys.
5. [ ] Authorization: every route with a second user from another workspace (IDOR), every role against every
       route, guest and viewer tokens, kicked members on live sockets.
6. [ ] Relay: ticket replay, malformed and oversized frames, `seq` manipulation on resume, slow-consumer behaviour,
       cross-session leakage, anything in logs, metrics, errors or close reasons that is not an id or a code.
7. [ ] Data: history and snapshot access after removal, pre-signed URL scope and expiry, share-link entropy,
       export and deletion flows.
8. [ ] Billing: forged and replayed webhooks, price and URL tampering, idempotency conflicts, coupon guessing,
       plan state after out-of-order events.
9. [ ] Webhooks: SSRF (private ranges, DNS rebinding, redirects), signature verification on the receiver side,
       payload contents.
10. [ ] Edge and deploy: admin path and metrics hidden, body limits, headers and CORS, TLS configuration, open ports
        (only 80 and 443), container privileges, secrets in the image or environment of a container that should not have them.
11. [ ] Supply chain: a lockfile change that adds an install script, a typosquatted dependency.
12. [ ] Retest: each fix gets a regression test (GUIDELINES section 4.6) and the tester confirms.

## Known open items

- **TM-DATA-06**: restoring a backup can resurrect accounts that were deleted after the backup. There is no
  tombstone log yet.
- **TM-BILL-08**: dunning reminders and the automatic drop to the free plan after the grace period are not
  driven in the API process.
- **TM-OPS-06**: SPF, DKIM and DMARC need a domain and DNS access (a human step).
- **Telemetry endpoint**: `POST /v1/telemetry/events` (B085) and its ingest are built and tested but not registered in
  `apps/api/src/modules.ts`, so the live API answers 404 to it. The leak guard is in the ingest and the REST hook
  exempts the route, ready for when it is mounted.
- No pen-test seed script, `security.txt`, disclosure policy page or ASVS mapping exists yet; they are
  written-down intentions of the lane card, not deliverables of this change.
