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

## What it serves

The login slice: `/healthz`, `/readyz`, `/v1/status`, `/.well-known/jwks.json`,
`/v1/auth/token`, `/v1/auth/revoke`, `/v1/auth/device/code`, `/v1/auth/authorize`,
`/login/email` and its verify routes, `/device` (the pages), `/v1/me`, `/v1/devices` and
`/v1/auth/devices`. The other modules (billing, sessions, webhooks, usage, admin, ...) are built
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

| Key                       | Meaning                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `DEV_MAILPIT_URL`         | Development only: Mailpit's HTTP address. Setting it turns e-mail sign-in on.    |
| `DEVICE_VERIFICATION_URI` | The address terminals tell people to open; default `https://centcom.dev/device`. |

Everything else is the lanes' own settings (`docs/config.md`): the base, token keys, pagination,
rate limits, status, PKCE and sign-in links.

## Not done yet

- Production mail: sign-in links go through B032's email service and its worker, which this
  service does not start; only Mailpit is wired.
- The rate limiter counts every caller per address: the service does not tell it who a bearer
  token belongs to, because the auth plugin runs after the limiter. Authenticated callers share
  the anonymous budget until the two are ordered so bad credentials still count.
- The other modules, and the relay and worker entrypoints.
