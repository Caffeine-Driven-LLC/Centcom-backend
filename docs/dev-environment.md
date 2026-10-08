# Local dev environment

`pnpm dev:up` starts everything the backend talks to on your machine: Postgres, Redis, an
S3-compatible store and a mail catcher. It migrates and seeds the database, then prints the URLs.
It needs Docker (or Podman) with Compose, and nothing else: no cloud services, and no network once
the images are pulled. Lane B012; the stack is `infra/compose/docker-compose.yml` and the scripts
are in `tools/dev/`.

This stack is for one developer's machine. Automated tests do not use it: they start their own
throwaway databases (B010, `packages/testkit`).

## Commands

| Command          | What it does                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:up`    | Starts the stack, waits until every service is healthy, creates the buckets, writes `.env.local` if missing, migrates, seeds, prints the URLs. |
| `pnpm dev:down`  | Stops the stack and removes its containers. The data stays in named volumes.                                                                   |
| `pnpm dev:reset` | Stops the stack, deletes its volumes (every row, object and mail), then runs `dev:up`: back to the seeded state.                               |
| `pnpm dev:seed`  | Seeds `DATABASE_URL` again (from your environment, else `.env.local`). `dev:up` already runs it.                                               |

`dev:up` is safe to run again: running services stay up, applied migrations and existing seed rows
are skipped, and an existing `.env.local` is kept. With images cached it finishes in well under
90 s; if a service is not healthy within 90 s it prints that service's last 50 log lines and exits 1.

## Services and ports

Every port is published on `127.0.0.1` only, never on other interfaces. The password is the fixed
`dev-only` everywhere; nothing in this stack is valid in staging or production.

| Service        | Image                                        | Address                                                          | Move it with                     |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| Postgres       | `postgres:16`                                | `postgres://centcom:dev-only@127.0.0.1:5432/centcom_dev`         | `CENTCOM_DEV_POSTGRES_PORT`      |
| Redis          | `redis:7`                                    | `redis://127.0.0.1:6379/0`                                       | `CENTCOM_DEV_REDIS_PORT`         |
| MinIO (S3 API) | `bitnamilegacy/minio:2025.7.23-debian-12-r5` | `http://127.0.0.1:9000`, access key `centcom`, secret `dev-only` | `CENTCOM_DEV_MINIO_PORT`         |
| MinIO console  | (same)                                       | `http://127.0.0.1:9001`                                          | `CENTCOM_DEV_MINIO_CONSOLE_PORT` |
| Mailpit SMTP   | `axllent/mailpit:v1.31.4`                    | `127.0.0.1:1025`, any login accepted                             | `CENTCOM_DEV_SMTP_PORT`          |
| Mailpit web UI | (same)                                       | `http://127.0.0.1:8025`                                          | `CENTCOM_DEV_MAILPIT_PORT`       |

If a port is taken, `dev:up` says which one and which variable moves it, for example
`CENTCOM_DEV_POSTGRES_PORT=15432 pnpm dev:up`. Use the same variables for `dev:down` and
`dev:reset`. `.env.local` is written with the ports in use when it is created; delete it after
moving a port so the next `dev:up` writes it again.

MinIO stands in for Cloudflare R2. `dev:up` creates the buckets R2 has (B091) apart from backups:
`history`, `snapshots`, `exports` and `releases` (`infra/compose/minio-init.sh`, plain S3 calls).
MinIO stopped publishing `minio/minio` images, so the stack runs Bitnami's frozen build of the
2025-07-23 release. Any S3-compatible image can take its place: change `image:`, its credentials
and its data path in the compose file; the init script needs only the S3 API.

## `.env.local`

On the first `dev:up`, `.env.local` is written from the names in `.env.example` (B004), with
`DATABASE_URL` and `REDIS_URL` pointing at the stack and every other value as in the example. It is
git-ignored and never overwritten; delete it to get a fresh one. The services do not read it by
themselves: load it with Node's `--env-file=.env.local`, or `set -a; . ./.env.local; set +a` in
your shell.

## Seed data

The seed (`tools/dev/seed.ts`) writes the same rows every time, with fixed ids, so docs, scripts
and manual tests can refer to them. In code, import `SEED` from `tools/dev/seed.ts`
(`SEED.users.owner.id`, `SEED.workspace.id`, ...). It refuses to run with `NODE_ENV=production` or
against a database not named `centcom_dev` or `test_*`, and it writes everything in one
transaction, so a failed run leaves nothing behind and can simply be run again.

| Row          | Id                                           | Details                                                          |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------- |
| User, owner  | `usr_01KDVDNA00DEVSEED000000001`             | Olive Owner, `owner@acme-dev.test`                               |
| User, member | `usr_01KDVDNA00DEVSEED000000002`             | Max Member, `member@acme-dev.test`                               |
| User, guest  | `usr_01KDVDNA00DEVSEED000000003`             | Gil Guest, `guest@acme-dev.test`                                 |
| Workspace    | `wsp_01KDVDNA00DEVSEED000000001`             | Acme Dev, slug `acme-dev`, created by the owner                  |
| Memberships  | `mem_01KDVDNA00DEVSEED000000001` to `...003` | owner, member and guest of `acme-dev`, in that order             |
| Device       | `dev_01KDVDNA00DEVSEED000000001`             | `owner-laptop` (linux), the owner's                              |
| Device       | `dev_01KDVDNA00DEVSEED000000002`             | `member-desktop` (macos), the member's                           |
| Session      | `ses_01KDVDNA00DEVSEED000000001`             | "Paused demo session" in `acme-dev`, state `paused`, region `eu` |

Every row is dated 2026-01-01T00:00Z, the time in its ULID. The seed has no billing or entitlement
data (billing lanes) and no session members.

### Device keys are test-only

The two seeded devices have fixed keys whose **private halves are public**: each is the SHA-256 of
a label in `tools/dev/seed.ts` (`seedDevicePrivateKey(device, kind)` returns it, for scripts that
act as that device). They are test-only. Never register them, or trust them, anywhere but a dev
stack; `SEED_TEST_PUBLIC_KEYS` lists them for code that rejects them outside development.

| Device                           | X25519 public key                             | Ed25519 public key                            | Fingerprint      |
| -------------------------------- | --------------------------------------------- | --------------------------------------------- | ---------------- |
| `dev_01KDVDNA00DEVSEED000000001` | `rjNaDJZfZXgceCLpPpS3VR_m0l_UiNOOy12xIODtYAs` | `4DM5_5Js4_6-ROaQJH1o-27jm1D3byA5kxzcC4YOUts` | `3OE7-23IB-PN3N` |
| `dev_01KDVDNA00DEVSEED000000002` | `FhjOgOBRLpqZWkjIkDyRyQjsqHb8R5rupyESVf01oVo` | `3h52evDDAdlgLTkxGYg6sfOD8oslNEMm2MTiV-n2hRk` | `IJIC-IOIW-BMYN` |

Fingerprints follow CT-CRYPTO §1: the first 12 characters of base32(BLAKE2b-256(X25519 key ‖
Ed25519 key)).

## Using the stack

- **Migrations**: `dev:up` runs `centcom-db migrate` (B007). To check where the database is:
  `NODE_ENV=development DATABASE_URL=postgres://centcom:dev-only@127.0.0.1:5432/centcom_dev pnpm --filter @centcom/db run migrate:status`
  (after `pnpm build`).
- **The API**: there is no runnable entrypoint yet. Once a lane adds `apps/api/src/main.ts`, build
  with `pnpm build` and start it with `node --env-file=.env.local` and that entrypoint's `dist/`
  file; it reads the stack's `DATABASE_URL` and `REDIS_URL` from `.env.local`.
- **The integration tests**: point the test harness at the stack and it creates (and drops) its own
  `test_*` databases on it, leaving `centcom_dev` alone:
  `DATABASE_URL=postgres://centcom:dev-only@127.0.0.1:5432/centcom_dev REDIS_URL=redis://127.0.0.1:6379/0 pnpm test`.
- **Mail**: send to `127.0.0.1:1025` and read it at `http://127.0.0.1:8025`.
- **psql**: `docker compose --file infra/compose/docker-compose.yml exec postgres psql --username=centcom --dbname=centcom_dev`.

## Resetting and troubleshooting

- **Back to a clean seeded state**: `pnpm dev:reset`. It keeps `.env.local`.
- **A port is taken**: `dev:up` names it and the variable that moves it (see above).
- **A service is not healthy**: `dev:up` prints its last 50 log lines. `docker compose --file
infra/compose/docker-compose.yml ps` shows every service's state; `logs <service>` the rest.
- **The seed fails**: nothing was written. Fix the cause (it is printed) and run `pnpm dev:seed`,
  or `pnpm dev:reset` to start over.
- **The smoke test**: `CENTCOM_DEV_SMOKE=1 pnpm vitest run --config vitest.workspace.ts tools/dev/smoke.test.ts`
  runs `dev:reset` and `dev:up` against real containers and checks the seeded rows. It wipes your
  stack, so it never runs by default.
