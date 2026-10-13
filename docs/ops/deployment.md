# Deploying Centcom to one small server

Lanes B091 and B092, the part that needs no cloud account: Docker images for the API, relay and
worker, one Docker Compose file, Caddy for HTTPS, and scripts that deploy, migrate safely and roll
back. Cloudflare sits in front. Everything is in [`infra/deploy/`](../../infra/deploy/).

```
 clients ──► Cloudflare (DNS, TLS, DDoS) ──► Caddy :443 ──► api   :3000  ─┐
                                                  └───────► relay :8080  ─┼─► postgres, redis, minio
                                              worker (no port) ───────────┘
```

Only Caddy publishes ports. The API, relay, worker, Postgres, Redis and MinIO talk on one private
Docker network. This is the **single-box layout**: one machine, no failover. A server reboot or a
deploy drops the relay's WebSockets for a few seconds; clients reconnect and resume from their last
`seq`. It is not the multi-region design the B091 card describes; it is the cheap first step.

## What is in the folder

| File                      | What it is                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `Dockerfile`              | One build, targets `api`, `worker`, `relay`. Non-root (`node`, UID 1000), `tini` as PID 1.     |
| `docker-compose.prod.yml` | The stack. Each service gets only the variables it reads.                                      |
| `Caddyfile`               | HTTPS, Cloudflare client addresses, `/internal/admin/*` and `/metrics` hidden.                 |
| `production.env.example`  | Every setting and secret, named and explained. `gen-env.mjs` turns it into `production.env`.   |
| `gen-env.mjs`             | Writes `production.env` (mode 600) with fresh random secrets and an Ed25519 signing key.       |
| `deploy.sh <tag>`         | Build, back up, migrate, start in order, check health, roll back if it fails.                  |
| `migrate-safe.sh`         | Backup, then migrate. Refuses a `-- contract` migration unless `--allow-contract`.             |
| `rollback.sh`             | `--images` goes back to the previous tag; `--restore-db <dump>` also restores the database.    |
| `drill-token.sh`          | Local drills only: mints a web-app token so `pnpm dev:branch-check` can run against the stack. |

The scripts are bash because they run on the server, which has Docker and bash but not the Subtype
compiler.

## One-time setup

1. **Server.** A Hetzner Cloud CX22 (2 vCPU, 4 GB, about 4 euro a month) is enough to start; take
   a CX32 (4 vCPU, 8 GB) if you expect a few thousand live sessions (the capacity numbers come
   with lane B095). Ubuntu 24.04. Create a non-root user, install Docker Engine with the
   compose plugin, add 2 GB of swap, turn on the Hetzner firewall with inbound 22, 80 and 443 only.
2. **Cloudflare.** Add the domain. Create two **proxied** (orange cloud) records, `api` and
   `relay`, pointing at the server's IPv4 (and IPv6). SSL/TLS mode **Full (strict)**. WebSockets
   are on by default. Add a Cache Rule that bypasses the cache for `api.<domain>/*`.
3. **Certificates.** Default: Caddy gets a Let's Encrypt certificate by itself (Cloudflare passes
   the HTTP-01 challenge on port 80 through). If you would rather use a Cloudflare Origin CA
   certificate, create one in the dashboard, put `origin.pem` and `origin.key` next to the
   Caddyfile and add `tls /etc/caddy/origin.pem /etc/caddy/origin.key` inside both site blocks
   (and mount the two files).
4. **Code and settings.**

   ```sh
   git clone https://github.com/Caffeine-Driven-LLC/Centcom-backend.git && cd Centcom-backend
   node infra/deploy/gen-env.mjs        # needs Node 22; or run it anywhere and copy the file over
   $EDITOR infra/deploy/production.env  # replace each CHANGE_ME; see the comments in the file
   ```

   Keep a copy of `production.env` in a password manager. `deploy.sh` refuses to run while a
   `CHANGE_ME` is left or the file is readable by others.

## Deploying

```sh
infra/deploy/deploy.sh v1
```

In order: check the settings, build the three images as `centcom-*:v1`, back up the database and
apply the pending migrations ([below](#migrations-and-backups)), start Postgres, Redis and MinIO,
then the API (waits until healthy), the worker, the relay (waits until healthy) and Caddy.

- A service that is not healthy within `DEPLOY_WAIT_S` (120 s) stops the deploy: the previous tag is
  started again and the script exits **20**. Exit 21 means the restore failed too.
- One deploy at a time: a second run stops with a message (a lock in `infra/deploy/.state/`).
- The previous tag's images stay on the server, so going back needs no build.
- `.state/history.log` lists every backup, migration, deploy and rollback with a timestamp.

Day to day: `docker compose -f infra/deploy/docker-compose.prod.yml --env-file infra/deploy/production.env ps|logs -f api`.

## Migrations and backups

Migrations are forward-only (`packages/db/CONVENTIONS.md`): each release must work with the schema
of the release before it, so a rollback of the code never needs a rollback of the database.
`migrate-safe.sh` (run by `deploy.sh`) does this, in order:

1. `centcom-db status`; nothing pending means it stops here, no backup.
2. On a database that already has data, a pending migration with a `-- contract` marker (one that
   may drop columns or tables) stops the deploy with exit 3. Check that the previous release no
   longer uses what it removes, then deploy with `--allow-contract`.
3. `pg_dump` (custom format) to `/backups/pre-<tag>-<time>.dump` on the `backups` volume, read
   back with `pg_restore --list`. The newest 10 pre-deploy dumps are kept (`BACKUP_KEEP`).
4. Apply. Each file runs in its own transaction under an advisory lock; a failing file changes
   nothing, and the script prints the exact restore command.

The services keep running the old code while migrations apply. Off-site, encrypted backups and a
tested restore drill are lane B099.

### Rolling back

- **Code only** (the usual case): `infra/deploy/rollback.sh --images` starts the previous tag, about
  a minute. Add `--to <tag>` for an older one.
- **Code and data**, when a migration or the new code damaged data:
  `infra/deploy/rollback.sh --restore-db pre-v2-20261013T160153Z.dump --to v1`. It stops the
  services, drops and recreates the database from the dump, and starts the old tag.
  **Everything written since the dump is lost**, so use it only for damage worse than that.

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | done                                                                      |
| 1    | a step failed (the message says which; a failed migration prints the fix) |
| 2    | usage, or the settings file is incomplete or world-readable               |
| 3    | a contract migration is pending and `--allow-contract` was not given      |
| 20   | the new version was unhealthy; the previous one is serving again          |
| 21   | the new version was unhealthy and restoring the previous one failed       |

## Secrets

`gen-env.mjs` creates all of these; the services see only what is marked for them.

| Setting                                                                     | Read by                         | What breaks if lost or leaked                                                         |
| --------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD`                                       | data services and the app       | Only reachable on the private network; rotate by editing the file and redeploying.    |
| `AUTH_SIGNING_KEYS`, `AUTH_SIGNING_KID`                                     | api, worker                     | Leak: anyone can mint tokens. Loss: everyone signs in again. Rotation: add a new key. |
| `IDEMPOTENCY_ENCRYPTION_KEY`                                                | api, worker                     | Loss: stored invite replies cannot be read; clients retry.                            |
| `CURSOR_SIGNING_KEYS`                                                       | api, worker                     | Loss: open pagination cursors stop working.                                           |
| `OBJECT_STORE_ACCESS_KEY_ID`, `..._SECRET_ACCESS_KEY`                       | minio, api, worker, relay       | The session history bucket.                                                           |
| `BACKUP_PASSPHRASE`                                                         | backup scripts (B099)           | **Loss: every backup is unreadable.** Keep it outside the server.                     |
| `RESEND_API_KEY`, `BREVO_API_KEY`, `POSTMARK_SERVER_TOKEN`, `SMTP_PASSWORD` | api, worker (the one you chose) | Sending mail as you ([mail.md](mail.md)).                                             |

Plain-text Postgres and Redis inside the private network are allowed explicitly
(`ALLOW_INSECURE_BACKENDS=1`); the services refuse that otherwise in production.

## Trying it on your own machine

`~/Desktop/actualprojects/subtype/ops/centcom-prod-drill.sub` (Subtype) builds the images, brings
the production compose up as project `centcom-prodtest` on port 18080 with throwaway volumes,
runs `pnpm dev:branch-check` against it and tears it down (`up`, `check`, `down`, `all`). Caddy
serves plain HTTP there (`http://` site addresses), and a database trigger puts new workspaces
on the Team plan, because production refuses `DEV_DEFAULT_PLAN`.

## Open gaps (read before going live)

1. **Sign-in mail needs a provider account.** The code is wired: set `EMAIL_PROVIDER` to `resend`,
   `brevo`, `postmark` or `smtp` with its key and a verified sending domain, and the API queues
   sign-in links and invites while the worker delivers them ([mail.md](mail.md)). Until a human
   creates the account and the SPF/DKIM records, the default `console` keeps e-mail sign-in off.
2. **Nobody has a paid plan.** Billing is not connected to the API process, new accounts are on
   Free, and Free cannot create a hosted session. `DEV_DEFAULT_PLAN` is refused in production. The
   stop-gap is one SQL statement per workspace:
   `insert into workspace_entitlements (workspace_id, plan_id, status) values ('wsp_...', 'team', 'active') on conflict (workspace_id) do update set plan_id = 'team', status = 'active';`
3. **No high availability.** One server, one database. B091's multi-region Terraform design is
   not started (it needs cloud accounts).
4. **No off-site backups yet** (B099), no WAF or rate-limit rules at Cloudflare (B097), no load
   numbers (B095).
5. **Images are built on the server.** There is no registry and no image signing or scan yet.
