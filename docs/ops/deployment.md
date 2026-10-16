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
| `deploy.sh <tag>`         | Gate, build, back up, migrate, blue/green the API, smoke, SLO guard, roll back if any fails.   |
| `migrate-safe.sh`         | Lint, backup, then migrate. Refuses a `-- contract` migration unless `--allow-contract`.       |
| `migration-lint.mjs`      | Refuses a migration that would break the release still running (rename, NOT NULL, ...).        |
| `release-gate.mjs`        | Production needs a fresh green conformance report for the commit and the stage record.         |
| `smoke.mjs`               | healthz, readyz, status, JWKS, device-code start, a relay WebSocket upgrade.                   |
| `slo-guard.mjs`           | 5 minutes of Caddy's metrics: under 1 % 5xx, p95 within 2x the baseline; else roll back.       |
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
infra/deploy/deploy.sh v1 --env stage                                  # the stage server
infra/deploy/deploy.sh v1 --env production --approved-by "Ada Lovelace" \
  --stage-record stage-deploy-record.json                              # production
```

The server needs Docker, bash and Node 22 (the gate, the linter and the deploy record run on the
host), and [trivy](https://trivy.dev) in production. In order:

1. **Settings** are checked (no placeholder left, mode 600, compose validates).
2. **Release gate** (`release-gate.mjs`, exit **10** on a failure, nothing changed).
   - Production: `conformance-report.json` from `pnpm conformance` (B100) must be for the commit
     being deployed, under 24 h old, with no failed case.
   - Production also needs the stage server's `deploy-record.json` for the same commit, with
     result `deployed` (`--stage-record`): prod ships only what stage ran.
   - Production needs a named approver (`--approved-by`, or `DEPLOY_APPROVER`), recorded.
   - Stage needs the report only with `REQUIRE_CONFORMANCE=true`.
3. **Build** the three images as `centcom-*:v1`. In production, `trivy` must find no critical,
   fixable vulnerability in any of them (exit 10). `DEPLOY_SCAN=0` skips the scan, and the record
   says `scanned: false`.
4. **Migrations**: lint, back up, apply ([below](#migrations-and-backups)).
5. **Blue/green for the API.** The new API container starts _next to_ the old one, under the same
   service name, so Caddy sends requests to both as soon as the new one is healthy. The old one
   keeps serving until the checks below pass. The worker, then the relay (which drains its
   WebSockets for up to 60 s; clients resume from their last `seq`), then Caddy are updated in
   place. A changed Caddyfile is applied with a graceful `caddy reload` first.
6. **Smoke** (`smoke.mjs`): `/healthz`, `/readyz`, `/v1/status`, the JWKS (at least one key), a
   device-code start, and a WebSocket upgrade on the relay.
7. **SLO guard** (`slo-guard.mjs`, `--slo-window`, default 300 s), on Caddy's per-host request
   metrics (an internal `:9180` listener, never published):
   - 1 % of 5xx or more, or a p95 over twice the pre-deploy baseline, is a breach (exit **30**);
   - fewer than 20 requests in the window is nothing to judge, so it passes;
   - metrics that cannot be read are a breach in production and a warning in stage;
   - `--skip-slo` is allowed in stage only.
8. **The old API stops** (30 s to finish its requests), and `.state/deploy-record.json` records
   the run (with a copy per run under `.state/records/`):
   `{env, service, tag, digest: {api, worker, relay}, git_sha, started_at, finished_at, result,
approver, scanned}`.

**Rolling back on a failure in steps 5-7:** the new API container is removed (the old one never
stopped serving), and the previous tag's worker and relay start again. Exit **20** for an
unhealthy service or a failed smoke test, **30** for an SLO breach, and **21** if the restore
failed too. The record's `result` says which (`unhealthy`, `smoke_failed`, `slo_breach`, ...).
A failure takes at most `DEPLOY_WAIT_S` (120 s) plus the guard window to be detected; the rollback
itself is the old container staying up, plus a minute for the worker and the relay.

- One deploy at a time: a second run stops with a message (a lock in `infra/deploy/.state/`).
- The previous tag's images stay on the server, so going back needs no build.
- `.state/history.log` lists every backup, migration, deploy and rollback with a timestamp.

Day to day: `docker compose -f infra/deploy/docker-compose.prod.yml --env-file infra/deploy/production.env ps|logs -f api`.

## Migrations and backups

Migrations are forward-only (`packages/db/CONVENTIONS.md`): each release must work with the schema
of the release before it, so a rollback of the code never needs a rollback of the database.
`migrate-safe.sh` (run by `deploy.sh`) does this, in order:

1. `centcom-db status`; nothing pending means it stops here, no backup.
2. On a database that already has data:
   - `migration-lint.mjs` checks the pending files (exit **4**: split the change into an expand
     release and a contract release). It refuses:
     - `RENAME` of a column, table or constraint (add the new one, copy, drop it later);
     - `ADD COLUMN ... NOT NULL` without a `DEFAULT` (the old code's inserts would fail);
     - `ALTER COLUMN ... TYPE` (a rewrite);
     - `CREATE INDEX` on a table the file did not create (it blocks writes while it builds).
       The runner wraps each file in a transaction, so `CONCURRENTLY` is not possible; a table
       known to be small can be acknowledged with
       `-- deploy-lint: allow index-lock <table> (<why>)`;
     - `DROP COLUMN`, `DROP TABLE` and `SET NOT NULL`, unless they come after a `-- contract`
       marker.
   - A pending migration with a `-- contract` marker (one that may drop columns or tables) stops
     the deploy with exit 3. Check that the previous release no longer uses what it removes, then
     deploy with `--allow-contract`.
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
| 4    | a pending migration would break the release still running (lint)          |
| 10   | the release gate failed (conformance, stage record, or a vulnerability)   |
| 20   | unhealthy or failed the smoke test; the previous one is serving again     |
| 21   | the new version failed and restoring the previous one failed too          |
| 30   | the SLO guard saw a breach; the previous one is serving again             |

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
2. **Billing needs a Stripe account.** The code is wired ([billing/going-live.md](../billing/going-live.md)):
   with `STRIPE_SECRET_KEY` set, checkout, the portal and the signed webhook work and the worker applies
   subscriptions. Without it, new accounts are on Free (which cannot create a hosted session) unless
   `SELF_HOST_PLAN` gives them a plan. Never run against real Stripe so far.
3. **No high availability.** One server, one database. B091's multi-region Terraform design is
   not started (it needs cloud accounts).
4. **No off-site backups yet** (B099), no WAF or rate-limit rules at Cloudflare (B097), no load
   numbers (B095).
5. **Images are built on the server.** There is no registry, so there is no digest to promote
   from stage to prod. Production rebuilds the same commit (the gate checks the commit, and the
   record keeps each image's id), and images are not signed (cosign needs a registry). trivy scans
   them in production.
6. **The workflows are in the repository but off.** `deploy-stage.yml`, `deploy-prod.yml` and `rollback.yml`
   (under `.github/workflows/`) run these same scripts over SSH. Each is skipped until its host variable
   (`STAGE_HOST` / `PROD_HOST`) is set, so nothing deploys until a server exists.
7. **Not yet run on a real server.** The scripts and checks are tested (`infra/deploy/*.test.ts`)
   and the earlier steps were drilled on a local production compose. The blue/green step, the
   smoke test and the SLO guard have not been drilled end to end yet; do one stage drill (deploy,
   then a deliberately broken tag) before the first production deploy.

## Workflows

`deploy-stage.yml` (after `ci` is green on main), `deploy-prod.yml` (manual, for a commit that was deployed
to stage) and `rollback.yml` (manual: `images`, or `restore-db` which loses data written since the dump) run
the scripts on the server over SSH, so the server keeps the images and the state.

One-time setup, in the repository settings:

| What        | Name                                    | Notes                                                                                                      |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Environment | `stage`                                 | no reviewers needed                                                                                        |
| Environment | `production`                            | **required reviewers**; the person who starts a run is recorded as `--approved-by`                         |
| Secret      | `DEPLOY_SSH_KEY`                        | a deploy key for a non-root user on the server (can be set per environment)                                |
| Variables   | `STAGE_HOST`, `PROD_HOST`               | `user@host`; a workflow stays skipped while its variable is empty                                          |
| Variables   | `STAGE_KNOWN_HOSTS`, `PROD_KNOWN_HOSTS` | the output of `ssh-keyscan <host>`, checked by hand once; the connection is refused for any other host key |

`deploy-prod` also checks that the commit is on main and that stage deployed it (the stage run's artifact
`stage-deploy-record`); `deploy.sh` then applies the release gate (conformance report fresh and green, infra
check passed). Inputs are validated in the workflow and passed through environment variables, never
interpolated into a shell command.

Other workflows from the same lanes: `infra-check.yml` (B091: `pnpm infra:check` on changes under
`infra/terraform/`), `release-gate.yml` (B100: the conformance suite and gates G1 to G5 on every pull request
to main and nightly, report uploaded as `conformance-report`; the nightly run is against the local stack until a
stage target exists), `secret-guard.yml` (B101: `pnpm secret-guard:scan` on every pull request and weekly) and
`dependabot.yml` (B097: grouped weekly updates).
