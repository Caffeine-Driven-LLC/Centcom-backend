#!/usr/bin/env bash
# Starts the one-container Centcom test server (B112): builds the image if it is missing, runs it, waits until it is
# healthy and prints the exact settings for the terminal app, the desktop app and the web app. FOR TESTING ONLY.
#
#   infra/aio/run.sh [--host H] [--tls] [--fresh] [--console] [--single-port] [--rebuild] [--no-build]
#                    [--api-port N] [--relay-port N] [--mail-port N] [--door-port N] [--console-port N]
#                    [--tls-port N] [--ca-port N] [--s3-port N] [--s3-tls-port N] [--name NAME] [--volume NAME] [--wait SECONDS]
#
#   --host H       the name or address the apps will use (default localhost). Anything but localhost needs --tls,
#                  because the Centcom apps refuse plain http/ws to any other address.
#   --tls          HTTPS with a private certificate authority on --tls-port (8443); the CA is at http://H:8081/ca.crt.
#   --fresh        a throwaway server: no named volume, everything is gone when it stops (stop.sh removes it).
#   --console      also publish the MinIO console (9001).
#   --single-port  advertise the front door (8080) for both the API and the relay instead of 3000 and 8088.
#   --volume NAME  the data volume (default centcom-data); reuse it to keep accounts and sessions.
#
# Ports are published on 127.0.0.1 only, unless --host is another name (then on every interface).
# Running it again while the container runs just prints the settings. Exit: 0 healthy; 1 failed; 2 usage/machine.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

host=localhost tls=0 fresh=0 console=0 single=0 rebuild=0 nobuild=0 wait_s=240
api_port=3000 relay_port=8088 mail_port=8025 door_port=8080 console_port=9001 tls_port=8443 ca_port=8081 s3_port=9000 s3_tls_port=9443
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host="${2:?--host needs a value}"; shift 2 ;;
    --tls) tls=1; shift ;;
    --fresh) fresh=1; shift ;;
    --console) console=1; shift ;;
    --single-port) single=1; shift ;;
    --rebuild) rebuild=1; shift ;;
    --no-build) nobuild=1; shift ;;
    --api-port) api_port="${2:?}"; shift 2 ;;
    --relay-port) relay_port="${2:?}"; shift 2 ;;
    --mail-port) mail_port="${2:?}"; shift 2 ;;
    --door-port) door_port="${2:?}"; shift 2 ;;
    --console-port) console_port="${2:?}"; shift 2 ;;
    --tls-port) tls_port="${2:?}"; shift 2 ;;
    --ca-port) ca_port="${2:?}"; shift 2 ;;
    --s3-port) s3_port="${2:?}"; shift 2 ;;
    --s3-tls-port) s3_tls_port="${2:?}"; shift 2 ;;
    --name) AIO_NAME="${2:?}"; shift 2 ;;
    --volume) AIO_VOLUME="${2:?}"; shift 2 ;;
    --wait) wait_s="${2:?}"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die 2 "unknown option $1 (see --help)" ;;
  esac
done
[[ "$AIO_NAME" =~ ^[a-zA-Z][a-zA-Z0-9_.-]{1,40}$ ]] || die 2 "--name must be letters, digits, - _ ."
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die 2 "--host must be a host name or an address (got: $host)"
for p in "$api_port" "$relay_port" "$mail_port" "$door_port" "$console_port" "$tls_port" "$ca_port" "$s3_port" "$s3_tls_port"; do
  [[ "$p" =~ ^[0-9]+$ ]] && ((p >= 1 && p <= 65535)) || die 2 "bad port: $p"
done
local_host=0; [[ "$host" == localhost || "$host" == 127.0.0.1 ]] && local_host=1
if [[ $local_host -eq 0 && $tls -eq 0 ]]; then
  die 2 "--host $host needs --tls: the Centcom apps refuse plain http/ws for any address but localhost (see docs/ops/test-server-container.md)"
fi
need_docker

# ---- already running? --------------------------------------------------------------------------------------------
if exists "$AIO_NAME"; then
  is_ours "$AIO_NAME" || die 2 "a container named $AIO_NAME exists and is not a Centcom test server; pick another --name"
  if [[ "$(docker inspect --format '{{.State.Running}}' "$AIO_NAME")" == true ]]; then
    log "$AIO_NAME is already running (stop.sh stops it); settings below are from its labels"
    already=1
  else
    log "removing the stopped container $AIO_NAME (its volume is kept)"
    docker rm "$AIO_NAME" >/dev/null
    already=0
  fi
else
  already=0
fi

if [[ $already -eq 0 ]]; then
  # ---- ports free? ---------------------------------------------------------------------------------------------
  ports=("$mail_port")
  [[ $tls -eq 1 ]] || ports+=("$api_port" "$relay_port" "$door_port")
  [[ $console -eq 0 ]] || ports+=("$console_port")
  [[ $tls -eq 0 ]] && ports+=("$s3_port") || ports+=("$tls_port" "$ca_port" "$s3_tls_port")
  if command -v ss >/dev/null; then
    for p in "${ports[@]}"; do
      if ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; then
        die 2 "port $p is already in use on this machine; pick another with the --*-port options (see --help)"
      fi
    done
  fi
  mem_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  (( mem_kb > 1200000 )) || log "only $((mem_kb / 1024)) MB of memory is free; the server idles near 1 GB"

  # ---- image ---------------------------------------------------------------------------------------------------
  have=0; docker image inspect "$AIO_IMAGE" >/dev/null 2>&1 && have=1
  if [[ $rebuild -eq 1 || $have -eq 0 ]]; then
    [[ $nobuild -eq 0 ]] || die 1 "the image $AIO_IMAGE is not here and --no-build was given"
    log "building $AIO_IMAGE (the first build takes a few minutes; 10 to 20 on a Raspberry Pi 4)"
    docker build --file "$REPO_DIR/infra/aio/Dockerfile" --tag "$AIO_IMAGE" "$REPO_DIR"
  fi
  # ---- run -----------------------------------------------------------------------------------------------------
  bind=127.0.0.1; [[ $local_host -eq 1 ]] || bind=0.0.0.0
  if [[ $tls -eq 1 ]]; then
    public_api="https://$host:$tls_port"; public_relay="wss://$host:$tls_port/v1/ws"
  elif [[ $single -eq 1 ]]; then
    public_api="http://$host:$door_port"; public_relay="ws://$host:$door_port/v1/ws"
  else
    public_api="http://$host:$api_port"; public_relay="ws://$host:$relay_port/v1/ws"
  fi
  args=(--detach --name "$AIO_NAME" --label dev.centcom.aio=1
    --label "dev.centcom.aio.api=$public_api" --label "dev.centcom.aio.relay=$public_relay"
    --label "dev.centcom.aio.mail=http://$host:$mail_port" --label "dev.centcom.aio.tls=$tls"
    --label "dev.centcom.aio.host=$host" --label "dev.centcom.aio.ca_port=$ca_port"
    --stop-timeout 60 --restart unless-stopped
    --health-cmd /usr/local/bin/healthcheck.sh --health-interval 15s --health-timeout 8s
    --health-retries 4 --health-start-period 90s
    -e "TEST_SERVER_HOST=$host" -e "AIO_TLS=$tls" -e "AIO_PUBLIC_API_URL=$public_api"
    -e "AIO_RELAY_PUBLIC_URL=$public_relay" -e "AIO_TLS_PORT=$tls_port" -e "AIO_HTTP_CA_PORT=$ca_port" -e "AIO_S3_PORT=$s3_port" -e "AIO_S3_TLS_PORT=$s3_tls_port"
    -p "$bind:$mail_port:8025")
  # HTTPS mode publishes no plain-text way in to the API: only the front door over TLS, the CA download and the store.
  [[ $tls -eq 1 ]] || args+=(-p "$bind:$api_port:3000" -p "$bind:$relay_port:8088" -p "$bind:$door_port:8080")
  [[ $console -eq 0 ]] || args+=(-p "$bind:$console_port:9001")
  if [[ $tls -eq 0 ]]; then args+=(-p "$bind:$s3_port:$s3_port")
  else args+=(--cap-add NET_ADMIN -p "$bind:$tls_port:$tls_port" -p "$bind:$ca_port:$ca_port" -p "$bind:$s3_tls_port:$s3_tls_port"); fi
  # The Postgres base image declares a volume at its own data directory, which this image does not use: an empty tmpfs
  # there stops Docker from leaving an anonymous volume behind on every run.
  args+=(--mount "type=tmpfs,destination=/var/lib/postgresql/data")
  [[ -z "${SELF_HOST_PLAN:-}" ]] || args+=(-e "SELF_HOST_PLAN=$SELF_HOST_PLAN")
  if [[ $fresh -eq 1 ]]; then
    args+=(--label dev.centcom.aio.fresh=1)
    log "starting a throwaway server (no volume: everything is gone when it stops)"
  else
    args+=(--volume "$AIO_VOLUME:/data")
    log "starting $AIO_NAME with the data volume $AIO_VOLUME"
  fi
  docker run "${args[@]}" "$AIO_IMAGE" >/dev/null
fi

# ---- wait until healthy ---------------------------------------------------------------------------------------------
label() { docker inspect --format "{{index .Config.Labels \"dev.centcom.aio.$1\"}}" "$AIO_NAME"; }
public_api="$(label api)"; public_relay="$(label relay)"; mail_url="$(label mail)"; tls="$(label tls)"
host="$(label host)"; ca_port="$(label ca_port)"
t0=$(date +%s)
while :; do
  state="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$AIO_NAME")"
  [[ "$state" != "running/healthy" ]] || break
  if [[ "$state" != running/* ]] || (( $(date +%s) - t0 > wait_s )); then
    docker logs --tail 30 "$AIO_NAME" >&2 || true
    die 1 "the server did not become healthy ($state after $(( $(date +%s) - t0 )) s); the last log lines are above (docker logs $AIO_NAME)"
  fi
  sleep 2
done
log "healthy after $(( $(date +%s) - t0 )) s of waiting"

ca_note=""
if [[ "$tls" == 1 ]]; then
  mkdir -p "$AIO_STATE_DIR"
  docker cp "$AIO_NAME:/data/caddy/pki/authorities/local/root.crt" "$AIO_STATE_DIR/centcom-test-ca.crt" >/dev/null 2>&1 \
    && ca_note="$AIO_STATE_DIR/centcom-test-ca.crt"
fi

cat <<TXT

==========================================================================================
 Centcom test server is up.   FOR TESTING ONLY: development settings, no backups.
==========================================================================================

 API            $public_api
 Relay          $public_relay
 Mail (codes)   $mail_url     <- sign-in codes and links arrive here (Mailpit)
 Health         $public_api/healthz

 Every new account gets the Team plan (SELF_HOST_PLAN), so it can host sessions.

 --- Terminal app (centcom) and desktop app -------------------------------------------------
   export CENTCOM_API_URL=$public_api
   export CENTCOM_RELAY_URL=$public_relay
TXT
if [[ "$tls" == 1 ]]; then
  cat <<TXT
   export NODE_EXTRA_CA_CERTS=\$HOME/centcom-test-ca.crt      # the terminal app (Node) trusts this CA

   Get the CA certificate on each computer:   curl -o ~/centcom-test-ca.crt http://$host:$ca_port/ca.crt
   (or copy ${ca_note:-the file from the container: docker cp $AIO_NAME:/data/caddy/pki/authorities/local/root.crt .})
   The desktop app and a browser use the operating system's trust store:
     macOS    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/centcom-test-ca.crt
     Linux    sudo cp ~/centcom-test-ca.crt /usr/local/share/ca-certificates/centcom-test.crt && sudo update-ca-certificates
              (Chromium/Electron on Linux also read ~/.pki/nssdb: certutil -d sql:\$HOME/.pki/nssdb -A -t C,, -n centcom-test -i ~/centcom-test-ca.crt)
     Windows  certutil -addstore -f ROOT centcom-test-ca.crt     (an administrator prompt)
   Why: the apps refuse plain http/ws for any address that is not localhost, so this mode speaks https
   with its own certificate authority.
TXT
else
  echo "   (plain http/ws is accepted by the apps because the address is localhost)"
fi
cat <<TXT

 --- Web app (apps/web in the Centcom client repository) --------------------------------------
   VITE_API_BASE=$public_api VITE_RELAY_BASE=${public_relay%/v1/ws}   (then: pnpm web:dev)
   (in the app's settings the same values are api.base_url and relay.url)

 --- Next ---------------------------------------------------------------------------------------
   1. centcom login -> open the page it prints -> sign in with any address -> read the code or
      link at $mail_url (or: curl -s $mail_url/api/v1/messages).
   2. Start a session with /share (docs/ops/test-server-container.md).
   Logs: docker logs -f $AIO_NAME     Stop: infra/aio/stop.sh     Clean slate: infra/aio/reset.sh
TXT
