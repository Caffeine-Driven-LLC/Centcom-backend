# The API service

`apps/api/src/main.ts` is the process that serves the REST API. It reads the configuration once,
opens Postgres and Redis, builds the app and listens. Lane B102.

```
main.ts      the process: config, connections, signals, exit code
config.ts    every setting the service reads (composes the lanes' loaders)
context.ts   builds each lane's service from the config and the connections
app.ts       buildApp(deps): the Fastify instance, without a port
modules.ts   the list of route modules; the place a lane adds its routes
serve.ts     listen, and stop: drain requests in flight, then close the pools
pages/       the browser pages (the device approval pages)
```

## Running it on your machine

```
pnpm dev:up      # Postgres, Redis, MinIO, Mailpit, migrated and seeded (once)
pnpm dev:api     # the API on http://localhost:3000
```

`dev:api` reads `.env.local`, generates a signing key on its first run and appends it there (the
file is ignored by git), sends sign-in mail to Mailpit (read it at http://127.0.0.1:8025) and tells
terminals to approve sign-ins at `http://localhost:3000/device`. Ctrl-C stops it cleanly.

To sign in a terminal against it:

```
CENTCOM_API_URL=http://localhost:3000 centcom login --no-browser
```

Open the printed link, give an e-mail address (any: the seeded `dev@example.test` works), open the
mail in Mailpit, follow its link, check the device name and fingerprint against the terminal, and
press Allow.

## Two sessions on your machine

Sessions need the relay next to the API. With `pnpm dev:up` done, in three more terminals:

```
pnpm dev:api     # http://localhost:3000, and tells clients to use the relay below
pnpm dev:relay   # the relay on ws://localhost:8088/v1/ws (RELAY_PORT; 8080 is often taken)
```

Then check it with the client's own libraries (`../Centcom`, or `CENTCOM_CLIENT_DIR`):

```
pnpm dev:two-clients    # the seeded owner and member share a session; no sign-in
pnpm dev:two-accounts   # two brand-new accounts, from nothing (below)
```

`dev:two-clients` (`tools/dev/two-clients.ts`): the seeded owner hosts a session on `acme-dev`, the
seeded member joins it through the relay, the host grants the session keys, and each sends an
encrypted message that the other reads. It ends with `OK: both clients read both messages`.

### Two new accounts, from nothing

`dev:two-accounts` (`tools/dev/two-accounts.ts`, helpers in `tools/dev/client-kit.ts`) uses no seed
data. It ends with `OK: two new accounts shared a session`:

1. **Sign up.** Alice and Bob each use a new address (`alice-<hex>@dev.test`). Each signs in the
   way a terminal does: the client asks for a device code, the page `/device` signs the person in
   with the link mailed to Mailpit (http://127.0.0.1:8025), and Allow approves the device. The
   first sign-in creates the **user**, a **personal workspace** named after them with their
   `owner` membership (B013), and, in development, a **Team plan** for it: `dev:api` sets
   `DEV_DEFAULT_PLAN=team`, which writes an active `workspace_entitlements` row in the same
   transaction (the Free plan has no `relay_access`, so a new account on it could not host).
   The script checks `GET /v1/workspaces` and `GET /v1/workspaces/{id}/entitlements`.
2. **Create and invite.** Alice creates a session in her workspace (`POST /v1/sessions`) and
   invites Bob's address (`POST /v1/workspaces/{id}/invites`, which mails a link to Mailpit and
   returns the token once). Inviting needs `workspaces:write`, which a terminal's token does not
   hold, so the script mints Alice's web-app token with `pnpm dev:token <usr_ id> <dev_ id>`.
   Bob accepts (`POST /v1/invites/{token}/accept`) and is a member of Alice's workspace.
3. **Join and talk.** Bob joins the session through the relay (`POST /v1/sessions/{id}/join-token`,
   then `ws://localhost:8088/v1/ws`); the relay announces him (`control.member_joined`), Alice's
   client grants the session keys, and each reads the other's encrypted message.
4. **Share link.** Alice makes a link (`POST /v1/sessions/{id}/share-links`, the key stays in the
   fragment). A visitor with no account and no device turns it into a viewer ticket
   (`POST /v1/share-links/{token}/join`: a ticket with no `dev` claim, and a `guest_member` row),
   connects to the relay with it, is welcomed as a `viewer` under the name they gave, and receives
   the session's encrypted frames. The relay admits a ticket without `dev` only for a viewer with
   no capabilities, and reads the guest from `guest_member` (not `session_members`); the guest is
   refused (`not_a_member`, 4403) once its link is revoked or has expired, and counts toward the
   member cap. A guest checks who signed a frame with the members' public keys from
   `GET /v1/share-links/{token}/members` (B104, public: the link token is the credential; the live
   members' ids, names, slots, roles and device keys, no user ids or e-mail; its own rate limit of
   60 a minute per address and 120 per link; the same 404 as `join` for a revoked, expired or
   unknown link, an ended session or a workspace without the relay). The script connects at the
   protocol level; the client's own `joinViaShareLink` (client PR #145) gets a ticket from the link.

To use your own clients instead of these scripts: sign in for real with
`CENTCOM_API_URL=http://localhost:3000 centcom login --no-browser`, or mint a token for a seeded
person with `pnpm dev:token owner|member` (their device keys are in `tools/dev/seed.ts`,
`seedDevicePrivateKey`). The API hands the relay address to the client (the `relay_url` of a
created session and of a join token); a client allows `ws://` to a loopback relay only when it is
told to (`allowPlainWs`).

Why it works on a laptop:

- The Free plan has no `relay_access`, and the API and the relay both check it. The seed puts
  `acme-dev` on the Team plan (a row someone changed is left alone), and `DEV_DEFAULT_PLAN` does
  the same for new accounts.
- The relay verifies tickets with `RELAY_JWKS_URL` (the API's keys, which `dev:relay` sets) and
  reads sessions, members, devices and plans from the same Postgres.
- The relay announces a member's first connection as `control.member_joined`; the host's client
  answers it with the keys (`key.grant`). Without it the newcomer waits for keys forever.
- `dev:api` raises the sign-in and anonymous rate limits (a laptop is one address) and generates
  an `IDEMPOTENCY_ENCRYPTION_KEY` in `.env.local` (invite replies carry a token, so they are kept
  encrypted).

Not done locally: the monthly quota counters (nothing is metered), delivery of host changes to the
relay and of session state changes (`control.session_state` on pause or end by the API), the
purge of deleted workspaces, real mail (invites and sign-in go to Mailpit through a development
queue until the worker's mail queue is on the list), and the history and snapshot routes. The relay
logs `relay.resume_without_durable_log`: a client that reconnects after a long gap gets no replay.

## What it serves

The login slice: `/healthz`, `/readyz`, `/v1/status`, `/.well-known/jwks.json`,
`/v1/auth/token`, `/v1/auth/revoke`, `/v1/auth/device/code`, `/v1/auth/authorize`,
`/login/email` and its verify routes, `/device` (the pages), `/v1/me`, `/v1/devices` and
`/v1/auth/devices`; the workspaces, their members and entitlements (`/v1/workspaces`, `/members`,
`/entitlements`); invites (`/v1/workspaces/{id}/invites`, `/v1/invites/...`, which need mail and the
idempotency key); and, when `RELAY_PUBLIC_URL` is set, the session routes (`/v1/sessions`: list,
create, get, patch, end, join-token, claim-host, members) and share links. The other modules (billing, sessions, webhooks, usage, admin, ...) are built
and tested but not yet on the list in `modules.ts`; each lane adds its entry there.

A module whose settings are missing is left out with one `api.module_skipped` log line and the
rest of the service still starts (for example, without `DEV_MAILPIT_URL` there is no e-mail
sign-in).

## Starting and stopping

- Invalid configuration: the process prints which keys are wrong (never their values) and exits 1
  before it opens a port.
- Postgres or Redis unreachable at start: three tries, one second apart, then exit 1.
- `SIGTERM` or `SIGINT`: stop accepting connections, let requests in flight finish (at most 30 s),
  close the pools, exit 0. Exit 1 if that takes longer.
- `/healthz` is 200 while the process runs; `/readyz` is 200 only while the database answers and
  its migrations are current, and Redis answers.

## The device approval pages

`GET /device[?user_code=]` shows the entry form or, with a code, what is asking for access (device
name, platform, fingerprint) and the Allow and Deny buttons. A visitor who is not signed in is sent
to `/device/login` (an e-mail form), and comes back to `/device` after following the mailed link;
the code they came with is kept in a cookie for those ten minutes.

Every page is `no-store`, has a CSP that allows no script, no framing and no referrer, and every
form carries a CSRF token (a cookie and a field that must match). A code that is wrong, expired,
already decided or not this person's gets the same page. After ten wrong codes in ten minutes, a
user (or an address) is locked out for fifteen, and the page says so the same way for every kind of
wrong code.

## Settings the service adds

| Key                       | Meaning                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `DEV_MAILPIT_URL`         | Development only: Mailpit's HTTP address. Setting it turns e-mail sign-in on.            |
| `DEVICE_VERIFICATION_URI` | The address terminals tell people to open; default `https://centcom.dev/device`.         |
| `RELAY_PUBLIC_URL`        | The relay's WebSocket address clients are given. Setting it turns the session routes on. |
| `RELAY_REGION`            | The region name sessions get (default `local`).                                          |

Everything else is the lanes' own settings (`docs/config.md`): the base, token keys, pagination,
rate limits, status, PKCE and sign-in links.

## Not done yet

- Production mail: sign-in links go through B032's email service and its worker, which this
  service does not start; only Mailpit is wired.
- The rate limiter counts every caller per address: the service does not tell it who a bearer
  token belongs to, because the auth plugin runs after the limiter. Authenticated callers share
  the anonymous budget until the two are ordered so bad credentials still count.
- The other modules, and the relay and worker entrypoints.
