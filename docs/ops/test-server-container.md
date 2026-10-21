# The whole test server in one container

Lane B112. One Docker container hosts everything the Centcom apps talk to, so the whole product can be tried on one
machine in about a minute: the API, the relay, the worker, Postgres 16, Redis 7, MinIO (the S3 store the relay and the
session snapshots need), Mailpit (sign-in codes you read in a browser) and Caddy (one front door). Every new account is on
the Team plan (`SELF_HOST_PLAN=team`), so a Free account can host sessions.

**This server is for testing only.** See "What is not safe" below. It is the same idea as the Raspberry Pi stack
([pi-test-server.md](pi-test-server.md), `infra/pi/`, eight containers under compose) in a single image: the Pi stack is
better for a board that stays on (separate services, one memory limit and health check each); this one is better for a quick
`docker run` on a laptop, for demos and for CI-like trials. Both run the product's own code from `infra/deploy/Dockerfile`.

## Run it

```sh
infra/aio/run.sh                  # builds the image the first time (a few minutes), starts, waits, prints the settings
infra/aio/run.sh --fresh          # a throwaway server: no volume, everything is gone when it stops
infra/aio/stop.sh                 # stops and removes the container; the data volume (centcom-data) stays
infra/aio/reset.sh                # also deletes the data volume: accounts, sessions, mail, secrets
```

Or by hand, without the scripts:

```sh
docker build -f infra/aio/Dockerfile -t centcom-test:aio .
docker run -d --name centcom-test -v centcom-data:/data \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:8088:8088 -p 127.0.0.1:8025:8025 -p 127.0.0.1:9000:9000 centcom-test:aio
```

Without `-v ...:/data` the server is a throwaway: a new volume appears with each `docker run`; use `docker rm -v` to remove it.
`run.sh` names the container `centcom-test`, adds a health check, labels the container (`dev.centcom.aio=1`) and only ever
touches a container with that label, so other containers on the machine are never stopped or removed. When the server is
ready (about 10 seconds), `run.sh` prints the exact settings below.

`run.sh` options: `--host H`, `--tls`, `--fresh`, `--single-port`, `--console`, `--rebuild`, `--no-build`, `--volume NAME`,
`--name NAME`, `--wait SECONDS` and `--api-port`, `--relay-port`, `--mail-port`, `--door-port`, `--console-port`,
`--s3-port`, `--tls-port`, `--ca-port`, `--s3-tls-port` (run it with `--help`). It refuses a port that is already in use.

## Ports

| Port | What                                                 | Published by `run.sh`                                     |
| ---- | ---------------------------------------------------- | --------------------------------------------------------- |
| 3000 | API                                                  | yes (127.0.0.1)                                           |
| 8088 | relay (WebSocket `/v1/ws`)                           | yes                                                       |
| 8080 | front door: API and relay behind one port (Caddy)    | yes; `--single-port` advertises it for both               |
| 8025 | Mailpit web UI and API (sign-in codes)               | yes                                                       |
| 9000 | MinIO S3 (clients upload session snapshots here)     | yes (plain mode)                                          |
| 9001 | MinIO console (login: the keys in `secrets/aio.env`) | only with `--console`                                     |
| 8443 | HTTPS front door, `--tls` only                       | with `--tls` (then 3000, 8088 and 8080 are not published) |
| 8081 | the CA certificate (`/ca.crt`), `--tls` only         | with `--tls`                                              |
| 9443 | MinIO over HTTPS, `--tls` only                       | with `--tls`                                              |

Ports are published on `127.0.0.1` only, unless `--host` names another address. Postgres (5432), Redis (6379) and the
Mailpit SMTP port (1025) are not published and listen on the container's loopback only.

## Pointing the apps at it

The Centcom apps refuse plain `http`/`ws` to any address that is not `localhost`, so on the machine that runs the container
the default (plain) mode works, and for another computer there is an HTTPS mode (next section). `run.sh` prints this,
filled in:

```sh
# terminal app (and the desktop app, which reads the same settings)
export CENTCOM_API_URL=http://localhost:3000
export CENTCOM_RELAY_URL=ws://localhost:8088/v1/ws

# the web app (apps/web in the client repository)
VITE_API_BASE=http://localhost:3000 VITE_RELAY_BASE=ws://localhost:8088      # then: pnpm web:dev
```

The settings in the apps are `api.base_url` and `relay.url`. Then `centcom login`, open the page it prints, enter any e-mail
address, and read the mail at http://localhost:8025.

### Reading the sign-in code

Sign-in mail goes API, queue, worker, then **SMTP to the Mailpit in the container** (the production path with
`EMAIL_PROVIDER=smtp`), and shows up in the browser at `http://localhost:8025`. From a script:

```sh
curl -s http://localhost:8025/api/v1/messages | head -c 400          # the newest first
curl -s http://localhost:8025/api/v1/message/<ID>                    # "Text" holds the link or code
```

### Another computer: HTTPS with a private certificate authority (opt-in)

```sh
infra/aio/run.sh --tls --host 192.168.1.20        # the address or name the other computer will use
```

Caddy's own certificate authority signs a certificate for the host (a name or an address), and the apps are told
`https://HOST:8443` and `wss://HOST:8443/v1/ws`. Each computer that connects must trust the authority (the same approach as
`infra/pi/`, whose table of per-system commands `run.sh` prints):

```sh
curl -o ~/centcom-test-ca.crt http://192.168.1.20:8081/ca.crt          # plain HTTP serves this one file and nothing else
export NODE_EXTRA_CA_CERTS=$HOME/centcom-test-ca.crt                    # the terminal app is Node
export CENTCOM_API_URL=https://192.168.1.20:8443 CENTCOM_RELAY_URL=wss://192.168.1.20:8443/v1/ws
```

The desktop app and a browser use the operating system's trust store (macOS `security add-trusted-cert`, Linux
`update-ca-certificates` plus `~/.pki/nssdb`, Windows `certutil -addstore -f ROOT`). The session snapshots go to the object
store, whose presigned URLs the API hands to the clients, so MinIO is also served over HTTPS on 9443 with the same CA.
Inside the container the host name (or, for an IPv4 address, a loopback alias, which needs the `NET_ADMIN` capability that
`run.sh --tls` adds) points at the container itself, so the services do not need the network to find their own front door.
A side effect: with an IP address as `--host`, the machine that runs the container cannot use that address itself (use the
plain mode and `localhost` there). Tailscale, which gives a real certificate, avoids the CA: run the container on the
machine, `tailscale serve --bg --https=443 http://127.0.0.1:8080`, and set `AIO_PUBLIC_API_URL=https://<name>.ts.net`,
`AIO_RELAY_PUBLIC_URL=wss://<name>.ts.net/v1/ws` (the store then needs a name the clients can reach too; use `--tls`
instead if in doubt).

### Environment of the container

| Variable                                     | Default     | Meaning                                                                         |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `TEST_SERVER_HOST`                           | `localhost` | the name or address in every printed and advertised URL                         |
| `AIO_TLS`                                    | `0`         | `1`: HTTPS with the private CA (needs a `TEST_SERVER_HOST` for the certificate) |
| `AIO_PUBLIC_API_URL`, `AIO_RELAY_PUBLIC_URL` | derived     | override the advertised addresses (a tunnel, a proxy)                           |
| `SELF_HOST_PLAN`                             | `team`      | the plan every new personal workspace gets                                      |
| `LOG_LEVEL`                                  | `info`      | log level of the API, worker and relay                                          |
| `AIO_DATA_DIR`                               | `/data`     | where everything lives                                                          |

## What is inside, and where the data lives

One bash entrypoint under `tini` (PID 1) does, in order: makes the secrets on the first start (`/data/secrets/aio.env`, mode
600, from `/dev/urandom`, plus an Ed25519 token signing key made with the container's Node; nothing secret is in the image),
initialises Postgres, starts Postgres, Redis, MinIO and Mailpit, creates the four buckets (`infra/compose/minio-init.sh`),
applies the migrations (the normal runner, `centcom-db migrate`: advisory-locked, one transaction per file; the safe runner
`migrate-safe.sh` needs compose and a backup volume and is not used), starts the API, the worker and the relay, then Caddy,
and prints a ready banner with the time it took. A small supervisor loop per service restarts it when it dies (1 s, doubling
to 30 s for a crash loop). `docker stop` (SIGTERM) stops the services in reverse order, Postgres last with a fast shutdown,
and exits 0; give it time (`run.sh` sets a 60 s stop timeout; the relay drains its sockets).

| Path in `/data`      | What                                        |
| -------------------- | ------------------------------------------- |
| `secrets/aio.env`    | passwords, signing keys (mode 600)          |
| `postgres/`          | the database                                |
| `redis/`             | a small snapshot of the job queue           |
| `minio/`             | the relay's log, session history, snapshots |
| `mailpit/mailpit.db` | the mail catcher's messages                 |
| `caddy/`             | the certificate authority (`--tls`)         |

The HEALTHCHECK (`infra/aio/healthcheck.sh`, every 15 s) needs the API and the relay to answer `/readyz`, Postgres to accept
a connection, Redis to answer `PING`, and MinIO, Mailpit and the front door to answer.

Base: the official `postgres:16-bookworm` image; Node, `redis-server` and `redis-cli` are copied from the official Node and
Redis images; the API, relay and worker code comes from the same build stage as `infra/deploy/Dockerfile` (a test keeps the
two identical, so the layers are shared). Mailpit and Caddy are downloaded with a pinned version and a sha256 for amd64 and
arm64 (`TARGETARCH`). MinIO: its download server (dl.min.io) has stopped serving release binaries (HTTP 410), so the binary is
copied from `bitnamilegacy/minio:2025.7.23-debian-12-r5`, the image `infra/pi/` uses, pinned by its multi-arch digest.
Every base image is pinned by tag and digest.

## Settings that differ from production

Rate limits are relaxed (`RATELIMIT_AUTH_LIMIT=200`, `RATELIMIT_ANONYMOUS_LIMIT=300`) because a scripted check signs several
accounts in within a minute; `ALLOW_INSECURE_BACKENDS=1` (plain connections inside the container); `TRUSTED_PROXY_HOPS=1`;
Postgres has `synchronous_commit=off`, 128 MB of shared buffers and 50 connections. Node heaps are capped (256 MB, the worker
192 MB). Redis has `noeviction` (BullMQ needs it) and a 128 MB cap.

## What is not safe

Development settings, secrets in a plain file in the volume, no backups, mail readable by anyone who can reach port 8025,
the MinIO console, accounts that get the Team plan for free, `test-token.sh` (mints a login for any user: it exists only for
scripted checks and needs Docker access), a private CA, no monitoring, one disk, one container. Never expose it to the internet.

## Scripted checks against it

```sh
export PUBLIC_API_URL=http://localhost:3000 RELAY_PUBLIC_URL=ws://localhost:8088/v1/ws DEV_MAILPIT_URL=http://localhost:8025
export CENTCOM_APP_TOKEN_CMD=$PWD/infra/aio/test-token.sh        # a token without a browser, via docker exec
pnpm dev:branch-check      # also: pnpm dev:two-accounts, pnpm dev:full-check
```

From the client repository (read only against the server): `CENTCOM_API_URL=... CENTCOM_RELAY_URL=... DEV_MAILPIT_URL=...
python3 tools/dev/pty-branch.py` (the real terminal app in two pseudo-terminals, throwaway `HOME`s) and `pnpm dev:share`.

## What was verified, and what was not

Measured on an x86-64 Linux machine (8 cores, 31 GB), Docker with no emulator:

- **Build:** about 1.5 minutes with warm package caches; the image is 1.23 GB on disk.
- **Start:** `run.sh` returned (healthy) in 7 to 12 seconds on an empty volume; the entrypoint's banner said ready in 5 to 8 s.
- **Memory at idle** (nothing connected, after the checks below had run): 381 to 434 MiB (`docker stats`; cgroup anon memory
  359 MB). The target was under 1.5 GB.
- **Stop:** `docker stop` took 4.6 s and exited 0 (every service logged a clean shutdown). Killing Redis inside the container
  restarted it within a second and the container stayed healthy.
- **Live checks, plain mode (`localhost`):** `pnpm dev:branch-check` (all checks ok), `pnpm dev:two-accounts` and
  `pnpm dev:full-check` (history from the object store, snapshots, usage through the worker, plans: Team) passed; mail arrived by
  SMTP in Mailpit. A second `run.sh` on the same volume kept the secrets and the accounts.
- **Client checks, read only:** `python3 tools/dev/pty-branch.py` and `tools/dev/pty-watch.py` (the real `centcom` in
  pseudo-terminals, two accounts each, throwaway homes) passed. `pnpm dev:share` passed until its last section, a visitor
  joining a watch link, where the client's own `Account.join` throws `Sign in to share a session.` before contacting the server
  (a client-side expectation, not the container).
- **HTTPS mode** with `--host localhost`: CA download, `https`/`wss`, and `pnpm dev:full-check` (including the snapshot upload
  through the HTTPS object store) passed. With an IP address as the host, Caddy's certificate for the address is served
  (verified: a client trusting the CA completed the handshake and the API answered) and the services reach the address through
  the loopback alias (verified inside the container).

**Not verified:** arm64 (no emulator here, nothing was built or run). Checked instead: the Mailpit and Caddy arm64 downloads
exist, their sha256 values in the Dockerfile match the downloaded files (Caddy's also match the project's published sha512),
they are `ELF aarch64`, and the postgres, redis and node base images publish `linux/arm64/v8` (the MinIO source image
publishes `linux/arm64`). Also not verified: a second physical computer connecting in HTTPS mode (on the test machine the
host's firewall blocks a container reaching the host's own address, and the loopback alias makes the host's own address
unreachable from the host itself, so that path could not be run end to end), the desktop app, a browser web app, Windows and
macOS CA steps, the Pi's memory figure and build time, `--single-port` and the MinIO console. A restart policy of
`unless-stopped` is set by `run.sh`.
