#!/usr/bin/env bash
# Starts the Centcom test server on this machine (B112): checks the machine, builds the images (or uses the ones
# already here), makes the secrets once, migrates, starts everything, waits until it is healthy and prints the
# addresses and the settings the Centcom apps need. FOR TESTING ONLY.
#
#   infra/pi/up.sh [--host <name-or-address>] [--edge lan|tailscale|tunnel] [--rebuild] [--no-build]
#                  [--https-port N] [--http-port N] [--mail-port N] [--local-port N] [--project NAME]
#
#   --host        the name or address the apps will use (default: <hostname>.local, which Raspberry Pi OS
#                 announces on the local network). With --edge tailscale or tunnel: the public host name.
#   --edge lan        (default) HTTPS on the local network with a private certificate authority.
#   --edge tailscale  no TLS here; run `tailscale serve --bg --https=443 http://127.0.0.1:<local port, 8081>` and use the
#                     machine's *.ts.net name as --host.
#   --edge tunnel     a Cloudflare Tunnel container; put CLOUDFLARE_TUNNEL_TOKEN in infra/pi/.state/pi.env first
#                     and point the tunnel's hostname at http://caddy:8081.
#   --rebuild     build the images again even when they exist.  --no-build  never build (stop if they are missing).
#
# Running it again keeps the secrets (infra/pi/.state/pi.env); reset.sh --new-secrets makes new ones.
# Exit codes: 0 up and healthy; 1 failed; 2 usage or this machine cannot run it.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

host="" edge="lan" rebuild=0 nobuild=0 https_port="" http_port="" mail_port="" local_port="" project=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host="${2:?--host needs a value}"; shift 2 ;;
    --edge) edge="${2:?--edge needs lan, tailscale or tunnel}"; shift 2 ;;
    --rebuild) rebuild=1; shift ;;
    --no-build) nobuild=1; shift ;;
    --https-port) https_port="${2:?}"; shift 2 ;;
    --http-port) http_port="${2:?}"; shift 2 ;;
    --mail-port) mail_port="${2:?}"; shift 2 ;;
    --local-port) local_port="${2:?}"; shift 2 ;;
    --project) project="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die 2 "unknown option $1 (see --help)" ;;
  esac
done
[[ "$edge" =~ ^(lan|tailscale|tunnel)$ ]] || die 2 "--edge is lan, tailscale or tunnel"
[[ -z "$project" ]] || { PI_PROJECT="$project"; export PI_PROJECT; }
[[ "$PI_PROJECT" =~ ^[a-z][a-z0-9_-]{1,30}$ ]] || die 2 "the project name must be lower-case letters, digits, - or _"

# ---- 1. can this machine run it? -------------------------------------------------------------------
command -v docker >/dev/null || die 2 "Docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die 2 "the Docker Compose plugin is missing (apt install docker-compose-plugin)"
docker info >/dev/null 2>&1 || die 2 "Docker is installed but this user cannot talk to it (add yourself to the docker group, log in again)"
arch="$(docker_arch)"
case "$arch" in arm64 | amd64) ;; *) die 2 "this machine is $arch; the Centcom images exist for arm64 (a 64-bit Raspberry Pi OS) and amd64 only. Install the 64-bit OS." ;; esac
mem_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
total_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if (( mem_kb < 2300000 )); then
  die 2 "only $((mem_kb / 1024)) MB of memory is free and the stack needs about 2.3 GB: close other programs, stop other containers (docker ps), or lower the mem_limit lines in infra/pi/docker-compose.pi.yml and try again"
fi
disk_kb="$(df -Pk "$REPO_DIR" | awk 'NR==2 {print $4}')"
(( disk_kb > 6000000 )) || die 2 "less than 6 GB of disk is free here; the images and data need about 5 GB. Use a USB SSD."
(( total_kb > 3500000 )) || log "this machine has $((total_kb / 1024)) MB of memory in total; a 4 GB Pi is the target, expect it to be tight"

# ---- 2. settings ----------------------------------------------------------------------------------
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
[[ -n "$host" ]] || host="$(hostname).local"
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die 2 "--host must be a host name or an address (got: $host)"
fresh=0
[[ -f "$ENV_FILE" ]] || { fresh=1; log "making new secrets (kept in $ENV_FILE, mode 600, never committed)"; }
"$PI_DIR/gen-env.sh" "$ENV_FILE"
umask 077
set_kv() { # set_kv KEY VALUE: replaces or appends a line
  if grep -q -E "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >>"$ENV_FILE"; fi
}
https_port="${https_port:-$(env_value PI_HTTPS_PORT)}"; https_port="${https_port:-443}"
http_port="${http_port:-$(env_value PI_HTTP_PORT)}"; http_port="${http_port:-80}"
mail_port="${mail_port:-$(env_value PI_MAIL_PORT)}"; mail_port="${mail_port:-8025}"
local_port="${local_port:-$(env_value PI_LOCAL_PORT)}"; local_port="${local_port:-8081}"
if [[ "$edge" == lan ]]; then
  authority="$host"; [[ "$https_port" == 443 ]] || authority="$host:$https_port"
  public_api="https://$authority"; public_relay="wss://$authority/v1/ws"; profiles="lan"
else
  public_api="https://$host"; public_relay="wss://$host/v1/ws"; profiles=""
  [[ "$edge" != tunnel ]] || profiles="tunnel"
fi
set_kv PI_PROJECT "$PI_PROJECT"
set_kv PI_HOST "$host"
set_kv PI_EDGE "$edge"
set_kv PI_PROFILES "$profiles"
set_kv PI_HTTPS_PORT "$https_port"
set_kv PI_HTTP_PORT "$http_port"
set_kv PI_MAIL_PORT "$mail_port"
set_kv PI_LOCAL_PORT "$local_port"
set_kv PI_PUBLIC_API_URL "$public_api"
set_kv PI_RELAY_PUBLIC_URL "$public_relay"
set_kv PI_TAG "$(env_value PI_TAG | grep . || echo pi)"
if [[ "$edge" == tunnel ]]; then
  [[ -n "$(env_value CLOUDFLARE_TUNNEL_TOKEN)" ]] || die 2 "--edge tunnel needs CLOUDFLARE_TUNNEL_TOKEN in $ENV_FILE (Cloudflare dashboard > Zero Trust > Tunnels), and a public hostname pointing at http://caddy:8081"
fi
load_profiles
tag="$(env_value PI_TAG)"

# ---- 3. images -------------------------------------------------------------------------------------
have_images=1
for svc in api worker relay; do
  image_arch="$(docker image inspect --format '{{.Architecture}}' "centcom-$svc:$tag" 2>/dev/null || true)"
  if [[ -z "$image_arch" ]]; then have_images=0
  elif [[ "$image_arch" != "$arch" ]]; then
    die 1 "the image centcom-$svc:$tag is for $image_arch but this machine is $arch. Build it here: docker build -f infra/deploy/Dockerfile --target $svc -t centcom-$svc:$tag .   (or remove it: docker rmi centcom-$svc:$tag)"
  fi
done
if [[ $rebuild -eq 1 || $have_images -eq 0 ]]; then
  [[ $nobuild -eq 0 ]] || die 1 "the images centcom-{api,worker,relay}:$tag are not here and --no-build was given. Load them (docker load < images.tar) or build: infra/pi/up.sh"
  log "building the images for $arch (the first build takes 10 to 20 minutes on a Pi 4; later ones are cached)"
  # docker build, not compose build: compose wants every secret filled in, and the images hold none.
  for svc in api worker relay; do
    docker build --file "$REPO_DIR/infra/deploy/Dockerfile" --target "$svc" --build-arg SERVICE_VERSION="$tag" \
      --tag "centcom-$svc:$tag" "$REPO_DIR"
  done
fi

# The signing key is made with the image's own Node, so the Pi needs no Node of its own.
if [[ -z "$(env_value AUTH_SIGNING_KEYS)" ]]; then
  log "making the token signing key"
  kid="k$(date +%Y%m%d)"
  jwks="$(docker run --rm --entrypoint node "centcom-api:$tag" -e "
    const { generateKeyPairSync } = require('node:crypto');
    const j = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    process.stdout.write(JSON.stringify([{ kty: 'OKP', crv: 'Ed25519', kid: '$kid', x: j.x, d: j.d }]));")"
  [[ -n "$jwks" ]] || die 1 "could not make the signing key"
  set_kv AUTH_SIGNING_KID "$kid"
  # single quotes keep the JSON intact when compose reads the file
  echo "AUTH_SIGNING_KEYS='$jwks'" >>"$ENV_FILE"
fi

# ---- 4. start ---------------------------------------------------------------------------------------
log "starting the database and the object store"
compose up --detach --wait --wait-timeout 180 postgres redis minio >/dev/null
compose up minio-init >/dev/null
log "applying the migrations"
compose --profile tools run --rm --no-deps -T migrate >/dev/null
log "starting the Centcom services"
services=(api worker relay caddy mailpit)
[[ "$edge" != lan ]] || services+=(caddy-tls)
[[ "$edge" != tunnel ]] || services+=(cloudflared)
# Named, not "everything": minio-init is a one-shot that exits by design, and --wait would call that a failure.
compose up --detach --wait --wait-timeout 240 "${services[@]}" >/dev/null || {
  compose ps --all >&2 || true
  compose logs --no-color --tail 20 >&2 || true
  die 1 "something did not become healthy; the last log lines are above (infra/pi/logs.sh <service> shows more)"
}

# ---- 5. the CA, then the instructions -----------------------------------------------------------------
ca_file=""
if [[ "$edge" == lan ]]; then
  ca_file="$STATE_DIR/centcom-pi-ca.crt"
  for _ in $(seq 1 30); do
    compose cp caddy-tls:/data/caddy/pki/authorities/local/root.crt "$ca_file" >/dev/null 2>&1 && [[ -s "$ca_file" ]] && break
    sleep 1
  done
  [[ -s "$ca_file" ]] || log "could not copy the CA certificate yet; get it from http://$host:$http_port/ca.crt in a minute"
fi
mail_host="$host"; [[ "$edge" == lan ]] || mail_host="$(hostname).local"
api_hostport="$public_api"
cat <<TXT

==========================================================================================
 Centcom test server is up.   FOR TESTING ONLY: development settings, in-memory mail, no
 backups, a private certificate authority. Do not put anything you care about on it.
==========================================================================================

 API            $public_api
 Relay          $public_relay
 Mail (codes)   http://$mail_host:$mail_port     <- sign-in codes and links arrive here
 Health         $public_api/healthz

 Every new account gets the Team plan (SELF_HOST_PLAN), so it can host sessions.

 --- Terminal app (centcom) and desktop app -------------------------------------------------
   export CENTCOM_API_URL=$public_api
   export CENTCOM_RELAY_URL=$public_relay
TXT
if [[ "$edge" == lan ]]; then
  cat <<TXT
   export NODE_EXTRA_CA_CERTS=\$HOME/centcom-pi-ca.crt        # the terminal app (Node) trusts this CA

   Get the CA certificate on each computer:   curl -o ~/centcom-pi-ca.crt http://$host:$http_port/ca.crt
   (or copy $ca_file)
   The desktop app and a browser use the operating system's trust store:
     macOS    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/centcom-pi-ca.crt
     Linux    sudo cp ~/centcom-pi-ca.crt /usr/local/share/ca-certificates/centcom-pi.crt && sudo update-ca-certificates
              (Chromium/Electron on Linux also read ~/.pki/nssdb: certutil -d sql:\$HOME/.pki/nssdb -A -t C,, -n centcom-pi -i ~/centcom-pi-ca.crt)
     Windows  certutil -addstore -f ROOT centcom-pi-ca.crt     (an administrator prompt)
   Why: the apps refuse plain http/ws for any address that is not localhost, so this server speaks https
   with its own certificate authority.
TXT
fi
cat <<TXT

 --- Web app (apps/web in the Centcom client repository) --------------------------------------
   VITE_API_BASE=$public_api VITE_RELAY_BASE=${public_relay%/v1/ws}   (then: pnpm web:dev)
   (in the app's settings the same values are api.base_url and relay.url)

 --- Next ---------------------------------------------------------------------------------------
   1. On a computer: centcom login   -> open the page it prints -> sign in with any address ->
      read the code or link at http://$mail_host:$mail_port.
   2. Start a session, invite a second computer, try a watch link (docs/ops/pi-test-server.md).
   Logs: infra/pi/logs.sh [service]     Stop: infra/pi/down.sh     Clean slate: infra/pi/reset.sh
TXT
if [[ "$edge" == tailscale ]]; then
  echo
  echo " Tailscale: run on this machine  tailscale serve --bg --https=443 http://127.0.0.1:8081"
fi
if [[ "$edge" == tunnel ]]; then
  echo
  echo " Cloudflare tunnel: the public hostname must be $host, pointing at http://caddy:8081"
fi
if [[ $fresh -eq 1 ]]; then echo; echo " (new secrets were generated in $ENV_FILE)"; fi
