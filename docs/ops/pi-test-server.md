# A test server on a Raspberry Pi 4 (4 GB)

Lane B112. One command turns a spare Raspberry Pi into a small Centcom server on your network, so the whole product can
be tried by two computers (sign-in, hosted sessions in command post and branch mode, invites, watch links, board notes,
queue approvals, the Team section) before any real server exists.

**This server is for testing only.** It runs development-grade settings, keeps mail in memory, makes no backups and
uses a private certificate authority. Do not put anything on it that you care about. It proves that things work; it is
not a measure of capacity (lane B095 measured a laptop).

## What runs, and why compose

`infra/pi/docker-compose.pi.yml` runs the production images of lane B091 (API, relay, worker) unchanged, so what you try
is the product's own code, plus the stock images of Postgres 16, Redis 7, MinIO (the relay's durable log and session
history), Mailpit (sign-in codes in a browser) and Caddy (the front door). One compose file rather than one image: the
services stay separate, each has a memory limit and a health check, and a failure points at one container. All
containers are in one compose project (`centcom-pi`); the scripts only ever touch that project.

| Service  | Memory limit  | Notes                                                    |
| -------- | ------------- | -------------------------------------------------------- |
| api      | 384 MB        | Node heap capped at 256 MB                               |
| worker   | 256 MB        | jobs: expiry sweeps, usage, purges                       |
| relay    | 384 MB        | up to 300 connections                                    |
| postgres | 512 MB        | `shared_buffers` 128 MB, 50 connections, relaxed commits |
| redis    | 160 MB        | no persistence, `noeviction` (BullMQ needs it)           |
| minio    | 384 MB        | one disk, four buckets                                   |
| mailpit  | 96 MB         | in memory, 200 messages                                  |
| caddy    | 64 MB + 96 MB | a plain router, and the HTTPS front door in LAN mode     |

The limits add up to about 2.3 GB, under the 3 GB the lane asks for. Measured on an x86 laptop with nothing connected, the
stack used about **340 MB** (see "What was verified"); a Pi's arm64 images will differ a little.

## What to buy and how to set it up

- A Raspberry Pi 4 with 4 GB (8 GB works too), a **USB 3 SSD** for the system and the data. Do not run Postgres and MinIO
  from the SD card: they wear it out and make everything slow. Flash **Raspberry Pi OS Lite (64-bit)** to the SSD with
  Raspberry Pi Imager (set a host name, a user, SSH, and your Wi-Fi if you need it), and boot from USB.
- A heatsink or a fan case (a Pi 4 throttles around 80 degrees; image builds make it hot), and the official 5 V / 3 A power
  supply. A cable to the router is better than Wi-Fi.
- 64-bit matters: the images are built for arm64. `uname -m` must say `aarch64`.

From a fresh Pi (over SSH):

```sh
# 1. Docker and git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"        # then log out and in again
sudo apt-get install -y git

# 2. the code and the server
git clone https://github.com/Caffeine-Driven-LLC/Centcom-backend.git
cd Centcom-backend
infra/pi/up.sh                          # the first run builds the images: 10 to 20 minutes on a Pi 4
```

`up.sh` checks the board (Docker, architecture, free memory and disk), builds the images, makes the secrets once,
migrates the database, starts everything, waits until every service is healthy, and prints the addresses and the exact
settings for the apps. If it says there is not enough memory it names what to close; if it finds images for the wrong
architecture it prints the build command. Pass `--host <name-or-address>` if the board's name is not
`<hostname>.local` (Raspberry Pi OS announces that name on the local network; use the IP address if your network does not
resolve it).

Commands (all in `infra/pi/`):

| Command                  | What it does                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `up.sh`                  | build or reuse the images, make the secrets (kept on a second run), start, wait, print the settings     |
| `down.sh`                | stop what `up.sh` started (the data stays)                                                              |
| `logs.sh [service]`      | follow the logs                                                                                         |
| `reset.sh`               | delete the data (accounts, sessions, mail) and start clean next time; the certificate authority is kept |
| `reset.sh --new-secrets` | also delete the secrets and the certificate authority: new passwords, a new signing key, a new CA       |

`down.sh` and `reset.sh` act on the compose project only. Other containers on the Pi are never touched.

## Pointing the apps at it

`up.sh` ends with this, filled in. The Centcom apps refuse plain `http` and `ws` for any address that is not
`localhost` (the HTTP client throws "baseUrl must be https"; the relay URL must be `wss://`), so in LAN mode the server
speaks **HTTPS with its own certificate authority**, and every computer that uses it must trust that authority.

```sh
# terminal app (and the desktop app, which reads the same settings)
export CENTCOM_API_URL=https://raspberrypi.local
export CENTCOM_RELAY_URL=wss://raspberrypi.local/v1/ws
export NODE_EXTRA_CA_CERTS=$HOME/centcom-pi-ca.crt     # the terminal app is Node and trusts this CA

# the web app (apps/web in the client repository)
VITE_API_BASE=https://raspberrypi.local  VITE_RELAY_BASE=wss://raspberrypi.local   # then: pnpm web:dev
```

The settings are `api.base_url` and `relay.url` in the apps' configuration, or the environment variables above.

Trusting the CA, once per computer (`curl -o ~/centcom-pi-ca.crt http://raspberrypi.local/ca.crt` fetches it; plain HTTP
serves that one file and nothing else):

| System  | Command                                                                                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/centcom-pi-ca.crt`                                                                                                                                      |
| Linux   | `sudo cp ~/centcom-pi-ca.crt /usr/local/share/ca-certificates/centcom-pi.crt && sudo update-ca-certificates`; Chromium and Electron also read `~/.pki/nssdb`: `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n centcom-pi -i ~/centcom-pi-ca.crt` |
| Windows | `certutil -addstore -f ROOT centcom-pi-ca.crt` (administrator prompt)                                                                                                                                                                           |

Fetching the CA over plain HTTP trusts whatever answered; on your own network that is fine for a test, otherwise copy the
file with `scp` from the Pi (`infra/pi/.state/centcom-pi-ca.crt`).

### Other ways to reach it (no router port-forwarding, ever)

- **LAN** (default): the above.
- **Tailscale**: install Tailscale on the Pi and the computers, `infra/pi/up.sh --edge tailscale --host <pi>.<tailnet>.ts.net`,
  then on the Pi `tailscale serve --bg --https=443 http://127.0.0.1:8081`. Tailscale gives the name a real certificate,
  so **no CA has to be installed** and the apps work from anywhere on the tailnet.
- **Cloudflare Tunnel** (needs a Cloudflare account and a domain): create a tunnel, put its token in
  `infra/pi/.state/pi.env` as `CLOUDFLARE_TUNNEL_TOKEN`, point a public hostname at `http://caddy:8081`, and run
  `infra/pi/up.sh --edge tunnel --host <that hostname>`. Cloudflare terminates TLS, so again no CA. The server is then
  reachable from the internet through Cloudflare: use it only for a short test and `down.sh` afterwards.

## Reading the sign-in code

Sign-in mail is not sent anywhere: it goes to Mailpit. Open `http://raspberrypi.local:8025` in a browser on any computer
on the network. `centcom login` prints a page address and a code (`ABCD-EFGH`); open the page, enter any e-mail address,
and the mail with the link (and the code to confirm the device) appears in Mailpit. Mail lives in memory: a restart of the
mail container empties it.

## Testing session sharing with two computers

Set the environment above on both computers (and trust the CA). Use two different e-mail addresses.

1. **Computer A:** `centcom login`, sign in, then in a project folder `centcom`, `/share` to start a hosted session (every
   account is on the Team plan, `SELF_HOST_PLAN`, so Free accounts can host).
2. **Invite:** `/share invite <B's address>` on A. On **computer B**: `centcom login` with that address, then `centcom join
   <link>` (the invite arrives in Mailpit).
3. **Watch link:** on A `/share link` gives a viewer-only link; open it with `centcom join <link>` from a third terminal or
   account (a visitor): it reads the session and cannot send.
4. **Branch mode:** start the session in branch mode on A (the mode is chosen when the session is created), join on B,
   and each person runs their own agent. Both agents show in the Team section; add a board note on A and watch it appear
   on B.
5. **Approvals:** in a command-post session B asks for something, A approves with `/share run <n>`.

A scripted version of the branch-mode steps, run from a development machine against the Pi, is
`pnpm dev:branch-check` in this repository (see "Checking it from your own computer").

### Checking it from your own computer

```sh
export PUBLIC_API_URL=https://raspberrypi.local RELAY_PUBLIC_URL=wss://raspberrypi.local/v1/ws
export DEV_MAILPIT_URL=http://raspberrypi.local:8025 NODE_EXTRA_CA_CERTS=$HOME/centcom-pi-ca.crt
export CENTCOM_APP_TOKEN_CMD=$PWD/infra/pi/test-token.sh      # only works on the Pi itself; or run this on the Pi
pnpm dev:branch-check
```

`test-token.sh` mints tokens through the API image's own tool on the machine where it runs, so the full script is
simplest on the Pi (or any machine with the compose project); it needs the client repository checked out next to this one.

## How many users

It is a test box: a handful of people and a few sessions at once. The relay is capped at 300 connections and Postgres at 50.
Beyond that, expect slowness, not data loss.

## Failure messages you may meet

- _only N MB of memory is free_: close programs or stop other containers; or lower the `mem_limit` lines.
- _the image centcom-api:pi is for amd64 but this machine is arm64_ (or the other way round): `up.sh` prints the build command.
- _something did not become healthy_: the last log lines are printed; `infra/pi/logs.sh <service>` shows more. A first start on a
  slow SD card can exceed the wait; use an SSD.

## What is not safe for production

Development secrets (generated here, kept in plain text in `infra/pi/.state/pi.env`, mode 600), the in-memory mailer
(Mailpit shows every mail to anyone on the network, port 8025), no backups, a private CA, accounts that get the Team plan
for free, `test-token.sh` (mints a login for any user), no monitoring, one disk. Nothing here is hardened for the internet.
For a real server see [deployment.md](deployment.md).

## What was verified, and what was not

Verified on an x86-64 Linux machine with Docker (project `pitest`, other ports, throwaway volumes, torn down afterwards):
the images build (amd64); `up.sh` ends with every service healthy; a second `up.sh` keeps the secrets; the idle stack
used about 340 MB of memory; HTTPS with the private CA answers on the host's address and the CA downloads over plain HTTP;
the plain router answers on the loopback address; and `pnpm dev:branch-check` (two accounts signing up through the
device flow with the real client libraries and a mailed link, a branch-mode session, agents, approvals, file locks, board
notes) passed against it over `https`/`wss` (39 checks); `down.sh` stopped only the project's containers; `reset.sh` kept
the secrets and the CA, `reset.sh --new-secrets` made new ones and removed every container, volume and network of the
project. The compose file, the generated settings and the committed files are checked by tests in `infra/pi/`.

**Not verified: ARM.** No arm64 emulator is installed on the machine used, so nothing was built or run for linux/arm64.
What was checked instead: every base image publishes an arm64 manifest (`postgres:16`, `redis:7`, `axllent/mailpit`,
`caddy:2.10-alpine`, `bitnamilegacy/minio`, `cloudflare/cloudflared`, `node:22.23.3-bookworm-slim`), and the only native
npm package in production, `msgpackr-extract` (via bullmq), has linux-arm64 prebuilds and falls back to JavaScript when
scripts are off, as they are. Not run, and not run on a Pi: the 10 to 20 minute build time, the memory figure on the
board, Tailscale and Cloudflare Tunnel, the CA steps on macOS, Windows and Linux desktops, two real computers and a
desktop app. The checklist below is the manual test and is **not run in CI**.

### Manual checklist for the board (not run in CI)

- [ ] `uname -m` prints `aarch64`; `infra/pi/up.sh` finishes with every service healthy
- [ ] `docker stats --no-stream` totals under 3 GB at idle
- [ ] `curl -o ~/ca.crt http://<pi>/ca.crt`, trust it, `curl https://<pi>/healthz` prints `{"status":"ok"}`
- [ ] sign in from a second computer with a code read in Mailpit; start a hosted session; a second person joins by invite
- [ ] a visitor reads the session through a watch link
- [ ] a branch-mode session between two computers: both agents in the Team section, a board note reaches the other
- [ ] `infra/pi/reset.sh` leaves other containers on the Pi running; `down.sh` stops only this stack
- [ ] `up.sh` twice keeps the secrets; `reset.sh --new-secrets` makes new ones
