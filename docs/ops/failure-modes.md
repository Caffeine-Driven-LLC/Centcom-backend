# Failure modes: what fails open, what fails closed

Lane B096 (chaos and failure-mode tests). Each row is a promise the experiments below check.

Run them with `pnpm chaos:experiments` (needs Docker, or `DATABASE_URL` and `REDIS_URL`; `CHAOS_OUTAGE_S=60 pnpm chaos:experiments`
holds each outage for the card's 60 s instead of the default 8 s; `CHAOS_REPORT=chaos-report.json` writes
`{scenario, passed, steady_state_before, during, after, violations[]}` per scenario). They are skipped by a
plain `pnpm test` because they take minutes. The clock-skew experiment injects no fault and runs in the
normal test run whenever Postgres and Redis are available.

## The runner (`pnpm chaos`)

`pnpm chaos --scenario <id|all> --env local [--duration-s N] [--api-service api|api-green] [--api-url URL]
[--project NAME] [--env-file FILE] [--report FILE]`, `pnpm chaos heal --env local` and `pnpm chaos list`
(`infra/chaos/`). A scenario is a YAML file in `infra/chaos/scenarios/` (hypothesis, steady-state checks, faults,
checks that must hold while the fault is active, abort conditions, checks that must hold after healing); the shape is
`infra/chaos/scenario.schema.json`. The runner checks the steady state first, applies each fault to a service of one
compose project (`docker compose stop|kill|pause|restart`), polls the `during` checks, heals, polls the `expect` checks
and writes `chaos-report.json` (`{scenario, passed, steady_state_before, during, after, violations[]}`). Healing always
runs, also after an error or Ctrl-C; an abort condition that becomes true heals at once and fails the scenario.

- **It refuses production**: `--env prod` and any `--api-url` that is not a loopback address exit 2; `--env stage` exits 2
  too (the owner-run Fly extension is not built).
- **It touches only the compose project it is given** and signals no process of its own.
- Shipped scenarios: `redis-outage`, `postgres-kill`, `relay-restart`, `worker-kill`, `api-restart`. Verified: all five
  passed against the B112 test stack (the production images; `--file infra/pi/docker-compose.pi.yml --env-file infra/pi/.state/pi.env --project centcom-pi --api-url http://127.0.0.1:8081`), torn down afterwards.
- Not built from the card: Toxiproxy faults (latency, packet loss), the Fly stage mode, scenarios for the blob store, a
  webhook receiver, DNS and the relay partition, and invariant checkers such as seq continuity and the write ledger (those
  live in the vitest experiments below).

## Degradation policy

| Dependency         | `fail_mode` | What users see                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis`            | `degrade`   | `/healthz` 200, `/readyz` 503 (within seconds, so the load balancer stops sending). Signed-in reads and rate limits fail **open** but slowly (each Redis call waits up to the 2 s command timeout). Routes with a **required** `Idempotency-Key` (usage events, invites, checkout, webhook endpoints) fail **closed**: 503 with `Retry-After`. Live relay connections on a node keep exchanging frames; new joins need Redis. |
| `postgres`         | `closed`    | `/healthz` 200, `/readyz` 503, every route that reads or writes returns 503 with `Retry-After` (never a 200 for a write that did not happen). Recovers as soon as connections work (under a second after the proxy was restored; 1 s after a restarted server accepts connections).                                                                                                                                           |
| `blob_store`       | `degrade`   | Designed: live sessions are unaffected, snapshot commit and history reads answer a retriable 503. **Not exercised by an experiment yet** (see below).                                                                                                                                                                                                                                                                         |
| `stripe`           | `degrade`   | Checkout and portal answer 503 with `retry_after_s` when Stripe is unreachable and 502 when it refuses; webhooks already stored are processed later (8 attempts, then a dead-letter queue, replayable). The subscription read never calls Stripe.                                                                                                                                                                             |
| `email`            | `degrade`   | Mail is queued (BullMQ) and retried up to 5 times with backoff (Retry-After honoured), then dead-lettered; a permanent rejection is not retried. A down provider delays sign-in links, it does not break the API.                                                                                                                                                                                                             |
| `webhook_receiver` | `degrade`   | Deliveries retry with backoff and park in `webhook.dead`; a slow or failing receiver never slows the API (B081).                                                                                                                                                                                                                                                                                                              |

## Experiments and what was measured

Measured on the developer machine against real Postgres 16 and Redis 7, with the API in-process
(`apps/api/test/chaos/`). Faults come from a TCP fault proxy (`proxy.ts`: refuse, black hole, delay) and from
`docker kill`/`docker start`; no root, no Toxiproxy, nothing outside the test's own containers.

| Scenario                                  | Fault                                                                                        | Result (8 s outage)                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redis-refuse`, `redis-blackhole`         | Redis refuses or hangs                                                                       | `/readyz` 503 after 4 to 6 s (limit 15 s), `/healthz` 200, `/v1/me` 200, required-key route 503 + `Retry-After`; back to ready within 0.2 to 3.3 s (limit 30 s); the same key sent twice then runs once and replays. |
| `postgres-refuse`, `-blackhole`, `-delay` | Postgres refuses, hangs, or answers 1.5 s late                                               | `/readyz` 503, reads and writes 503 (+ `Retry-After`), a 1.5 s-late database lets some writes through as 201; writes resume in under 100 ms of restoring; the write ledger found no acknowledged write missing.      |
| `postgres-crash-restart`                  | `docker kill -s KILL` the Postgres container under 4 concurrent writers, then start it       | Only 503s while down (236 requests); writes resumed 1 s after the restart (limit 120 s); every one of the 103 acknowledged creates was in the database (crash recovery loses no committed write).                    |
| `relay-kill-restart`                      | B095's storm: SIGKILL the relay under 100 clients (1000 with `CHAOS_RELAY_CONNECTIONS=1000`) | Passed: clients welcome again within 60 s, nobody behind, no seq gap. The 1000-client run is in `docs/capacity.md`.                                                                                                  |
| clock skew (`clock-skew.test.ts`)         | One node 30 s to 17 min off                                                                  | Within 60 s either way accepted; issued more than 60 s in the future `token_invalid`; more than 60 s past the 15-minute expiry `token_expired`; nothing crashes.                                                     |

Already covered by other suites: Stripe duplicate and out-of-order webhooks
(`apps/api/test/billing/webhooks/webhook.ordering.test.ts`, `webhook.idempotency.test.ts`), email retry and
dead-letter (`apps/worker` email tests), webhook receiver failures (`apps/api/test/webhooks/`).

## Findings

- **Redis down makes every request slow, not failed**: 2 to 4.5 s per request while it is down (command timeout
  twice). It stays correct, but a circuit breaker that skips Redis after the first timeout would keep latency flat.
  Not fixed here (the lane's scope is to find, not fix).
- Slow storage is simulated as slow responses from Postgres. A real throttled block device was tried
  (`docker run --device-write-bps`) and was not enforced on this machine's overlay filesystem, so a true
  "slow disk" experiment needs a host where it is.

## Not done (needs more than this repository gives)

- Blob store (MinIO/R2) down for 5 minutes with snapshot and history assertions; DNS failure for webhook
  targets; network partition between relay nodes; a worker killed mid-job for each queue; the 1000-event Stripe
  storm at that size; Toxiproxy and Fly machine stop/restart on stage. None of the experiments ran in CI
  (workflows are protected paths): wire `pnpm chaos:experiments` and the runner as a nightly job if you want it there.
- Postgres **failover** to a replica is not tested: the stack has no replica (the crash-restart experiment is the
  single-server equivalent).
