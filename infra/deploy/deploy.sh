#!/usr/bin/env bash
# Deploys a tag to this server (B092): gate, build, back up and migrate, start the new API next to
# the old one, check it, watch it, and roll back on any failure.
#
#   infra/deploy/deploy.sh <tag> [--env stage|production] [--approved-by <name>]
#                          [--stage-record <file>] [--allow-contract] [--skip-build]
#                          [--skip-slo] [--slo-window <s>]
#
# Steps:
#   1. check the settings file (no placeholders, mode 600, compose validates);
#   2. the release gate (release-gate.mjs): production needs a fresh, green conformance report for
#      this commit and the stage server's deploy record for it, and a named approver
#      (--approved-by or DEPLOY_APPROVER); stage needs the report only with REQUIRE_CONFORMANCE=true;
#   3. build the api, worker and relay images as centcom-*:<tag> (the previous tag's images stay);
#      in production a critical vulnerability found by trivy stops the deploy (DEPLOY_SCAN=0 skips
#      the scan, and the record says so);
#   4. migrate-safe.sh: the pending migrations pass migration-lint.mjs, a pre-deploy backup, then
#      the migrations (every one works with the release still running);
#   5. blue/green for the API: the new version starts next to the old one and both serve once it
#      is healthy; then the worker, the relay (drains the old relay for up to 60 s) and caddy;
#   6. smoke.mjs against the new API and the relay;
#   7. slo-guard.mjs for --slo-window seconds (default 300): under 1 % 5xx and p95 within 2x the
#      baseline, from Caddy's request metrics;
#   8. the old API container stops; deploy-record.json records the run.
# Any failure in 5-7 removes the new API container (the old one keeps serving) and starts the
# previous tag's worker and relay again (rollback.sh --images).
# Only one deploy runs at a time (a lock in the state folder); a second one stops with a message.
#
# Exit codes: 0 deployed; 1 a step failed; 2 usage or incomplete settings; 3 contract migration
# pending; 4 an unsafe migration; 10 the release gate failed; 20 the new version was unhealthy or
# failed the smoke test, the previous one is serving again; 21 the restore failed too; 30 the SLO
# guard saw a breach, the previous version is serving again.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag="" env_name="${DEPLOY_ENV:-production}" approver="${DEPLOY_APPROVER:-}" stage_record=""
allow_contract=() skip_build=0 skip_slo=0 slo_window="${DEPLOY_SLO_WINDOW_S:-300}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) env_name="${2:?--env needs stage or production}"; shift 2 ;;
    --approved-by) approver="${2:?--approved-by needs a name}"; shift 2 ;;
    --stage-record) stage_record="${2:?--stage-record needs a file}"; shift 2 ;;
    --allow-contract) allow_contract=(--allow-contract); shift ;;
    --skip-build) skip_build=1; shift ;;
    --skip-slo) skip_slo=1; shift ;;
    --slo-window) slo_window="${2:?--slo-window needs seconds}"; shift 2 ;;
    -h | --help) sed -n '2,33p' "$0"; exit 0 ;;
    -*) die "$EXIT_USAGE" "unknown option $1" ;;
    *) tag="$1"; shift ;;
  esac
done
[[ -n "$tag" ]] || die "$EXIT_USAGE" "usage: deploy.sh <tag> [--env stage|production] [--approved-by <name>] ..."
[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "$EXIT_USAGE" "the tag must be letters, digits, . _ - (got: $tag)"
[[ "$env_name" == stage || "$env_name" == production ]] || die "$EXIT_USAGE" "--env must be stage or production (got: $env_name)"
[[ "$slo_window" =~ ^[0-9]+$ ]] || die "$EXIT_USAGE" "--slo-window must be whole seconds"
if [[ "$env_name" == production && -z "$approver" ]]; then
  die "$EXIT_USAGE" "a production deploy needs a named approver: --approved-by <name> (or DEPLOY_APPROVER)"
fi
if [[ "$env_name" == production && $skip_slo -eq 1 ]]; then
  die "$EXIT_USAGE" "--skip-slo is for stage only"
fi
export TAG="$tag"
WAIT_S="${DEPLOY_WAIT_S:-120}"

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die 1 "another deploy is running (lock $STATE_DIR/deploy.lock); wait for it to finish"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git_sha="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
scanned=false

# deploy-record.json (and a copy per run under records/): what ran, by whom, and how it ended.
record() {
  local result="$1" finished digests="{}"
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  digests="$(for s in api worker relay; do
    printf '%s %s\n' "$s" "$(docker image inspect -f '{{.Id}}' "centcom-$s:$tag" 2>/dev/null || echo none)"
  done | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n").map((x)=>x.split(" "));process.stdout.write(JSON.stringify(Object.fromEntries(l)))' 2>/dev/null || echo '{}')"
  mkdir -p "$STATE_DIR/records"
  ENV_NAME="$env_name" TAG_NAME="$tag" GIT_SHA="$git_sha" STARTED="$started_at" FINISHED="$finished" \
    RESULT="$result" APPROVER="$approver" DIGESTS="$digests" SCANNED="$scanned" node -e '
      const e = process.env;
      const rec = { env: e.ENV_NAME, service: "api,worker,relay", tag: e.TAG_NAME,
        digest: JSON.parse(e.DIGESTS || "{}"), git_sha: e.GIT_SHA, started_at: e.STARTED,
        finished_at: e.FINISHED, result: e.RESULT, approver: e.APPROVER || null,
        scanned: e.SCANNED === "true" };
      process.stdout.write(JSON.stringify(rec, null, 2) + "\n");' \
    | tee "$STATE_DIR/deploy-record.json" >"$STATE_DIR/records/${started_at//:/}-$tag.json" || true
}
fail() { # fail <code> <result> <message>
  record "$2"
  die "$1" "$3"
}

preflight_env
previous="$(state_get current-tag)"
log "deploying $tag to $env_name (running now: ${previous:-nothing})"

# 2. The release gate.
gate_args=(--env "$env_name" --git-sha "$git_sha" --conformance "${CONFORMANCE_REPORT:-$REPO_DIR/conformance-report.json}")
[[ -n "$stage_record" ]] && gate_args+=(--stage-record "$stage_record")
[[ "${REQUIRE_CONFORMANCE:-false}" == true ]] && gate_args+=(--require-conformance)
if ! node "$DEPLOY_DIR/release-gate.mjs" "${gate_args[@]}"; then
  fail "$EXIT_GATE" gate_failed "the release gate failed (above); nothing was changed"
fi

# 3. Build, and scan in production.
if [[ $skip_build -eq 0 ]]; then
  log "building images"
  compose build api worker relay
fi
if [[ "$env_name" == production && "${DEPLOY_SCAN:-1}" != 0 ]]; then
  command -v trivy >/dev/null || fail "$EXIT_GATE" gate_failed "trivy is not installed (DEPLOY_SCAN=0 skips the scan and records it)"
  for s in api worker relay; do
    log "scanning centcom-$s:$tag"
    trivy image --quiet --exit-code 1 --severity CRITICAL --ignore-unfixed "centcom-$s:$tag" \
      || fail "$EXIT_GATE" gate_failed "centcom-$s:$tag has a critical vulnerability; nothing was changed"
  done
  scanned=true
fi

# 4. Migrations (linted, backed up).
set +e
"$DEPLOY_DIR/migrate-safe.sh" --tag "$tag" "${allow_contract[@]}"
code=$?
set -e
[[ $code -eq 0 ]] || fail "$code" migrate_failed "the migration step failed (exit $code); the services were not changed"

up() { # up <service>... : start and wait for the health check
  compose up --detach --no-deps --wait --wait-timeout "$WAIT_S" "$@" >/dev/null 2>&1 || return 1
}

old_api=() new_api=()
# Removes the new API container (the old one keeps serving) and starts the previous worker, relay.
roll_back() { # roll_back <code> <result> <message>
  log "FAILED: $3"
  compose logs --no-color --tail 25 api worker relay 2>&1 | sed 's/^/    /' >&2 || true
  state_event "deploy $tag failed: $3"
  if [[ ${#new_api[@]} -gt 0 && ${#old_api[@]} -gt 0 ]]; then
    docker rm -f "${new_api[@]}" >/dev/null 2>&1 || true
  fi
  if [[ -z "$previous" ]]; then
    fail "$1" "$2" "no previous version to go back to; read the logs: docker compose logs"
  fi
  log "restoring $previous"
  if "$DEPLOY_DIR/rollback.sh" --images --to "$previous"; then
    fail "$1" "$2" "$tag was not kept ($3); $previous is serving again"
  fi
  fail "$EXIT_ROLLBACK_FAILED" rollback_failed "$tag failed ($3) and restoring $previous failed too: act now"
}

log "starting the data services and the object store buckets"
compose up --detach --wait --wait-timeout "$WAIT_S" postgres redis minio >/dev/null
compose up minio-init >/dev/null

# Caddy reads its file at start: a changed Caddyfile (such as the metrics listener the SLO guard
# needs) is applied with a graceful reload, before anything else changes.
api_host="$(env_value API_HOST)"
api_host="${api_host#*://}"
caddy_sha="$(sha256sum "$DEPLOY_DIR/Caddyfile" | cut -d' ' -f1)"
if [[ -n "$(compose ps --quiet caddy 2>/dev/null)" && "$(state_get caddyfile-sha)" != "$caddy_sha" ]]; then
  log "reloading caddy (its file changed)"
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
    || fail 1 caddy_reload_failed "caddy refused the new Caddyfile; nothing else was changed"
fi
state_set caddyfile-sha "$caddy_sha"

# The SLO baseline: Caddy's counters before the switch (none on a first deploy).
baseline="null"
if [[ -n "$previous" && $skip_slo -eq 0 ]]; then
  baseline="$(compose run --rm --no-deps -T deploy-check /deploy/slo-guard.mjs \
    --metrics http://caddy:9180/metrics --host "$api_host" --snapshot 2>/dev/null | tail -n 1)" || baseline="null"
  [[ -n "$baseline" ]] || baseline="null"
fi

# 5. Blue/green for the API: the new container joins the old one behind the same name, so Caddy
# sends traffic to both once it is healthy; the old one stops only after the checks pass.
mapfile -t old_api < <(compose ps --quiet api 2>/dev/null)
if [[ ${#old_api[@]} -eq 0 ]]; then
  up api || roll_back "$EXIT_UNHEALTHY" unhealthy "api did not become healthy (waited up to ${WAIT_S}s)"
else
  compose up --detach --no-deps --no-recreate --scale "api=$((${#old_api[@]} + 1))" \
    --wait --wait-timeout "$WAIT_S" api >/dev/null 2>&1 || {
    mapfile -t all_api < <(compose ps --all --quiet api 2>/dev/null)
    mapfile -t new_api < <(printf '%s\n' "${all_api[@]}" | grep -vxF -f <(printf '%s\n' "${old_api[@]}") || true)
    roll_back "$EXIT_UNHEALTHY" unhealthy "the new api did not become healthy (waited up to ${WAIT_S}s)"
  }
  mapfile -t all_api < <(compose ps --quiet api 2>/dev/null)
  mapfile -t new_api < <(printf '%s\n' "${all_api[@]}" | grep -vxF -f <(printf '%s\n' "${old_api[@]}") || true)
  log "api: new ${new_api[*]:0:1} serving next to old ${old_api[*]:0:1}"
fi
up worker || roll_back "$EXIT_UNHEALTHY" unhealthy "worker did not start"
# The relay recreated drains the old one (SIGTERM, up to 60 s); its clients reconnect and resume.
up relay || roll_back "$EXIT_UNHEALTHY" unhealthy "relay did not become healthy (waited up to ${WAIT_S}s)"
up caddy || roll_back "$EXIT_UNHEALTHY" unhealthy "caddy did not start"

# 6. Smoke.
log "smoke test"
compose run --rm --no-deps -T deploy-check /deploy/smoke.mjs --env "$env_name" \
  --api http://api:3000 --relay ws://relay:8080/v1/ws \
  || roll_back "$EXIT_UNHEALTHY" smoke_failed "the smoke test failed"

# 7. The SLO guard.
if [[ $skip_slo -eq 0 && "$slo_window" -gt 0 ]]; then
  log "watching the SLO for ${slo_window}s"
  compose run --rm --no-deps -T deploy-check /deploy/slo-guard.mjs --env "$env_name" \
    --metrics http://caddy:9180/metrics --host "$api_host" \
    --window "$slo_window" --baseline "$baseline" \
    || roll_back "$EXIT_SLO" slo_breach "the SLO guard saw a breach"
fi

# 8. Retire the old API.
if [[ ${#old_api[@]} -gt 0 ]]; then
  log "stopping the old api"
  docker stop --time 30 "${old_api[@]}" >/dev/null && docker rm "${old_api[@]}" >/dev/null
fi

state_set previous-tag "$previous"
state_set current-tag "$tag"
state_event "deployed $tag to $env_name (previous: ${previous:-none}, approver: ${approver:-none})"
record deployed
log "deployed $tag"
compose ps --format 'table {{.Service}}\t{{.Status}}'
