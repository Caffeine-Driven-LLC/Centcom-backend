# Quota signals (B076)

When a hosted workspace uses 80 % and then 100 % of a metered limit in a billing period, Centcom
tells the people concerned once: live hosted sessions get a `sys.notice`, the workspace's owners a
notification, webhook endpoints a `usage.threshold` event. A flag per workspace says where each
limit stands, so the API (B080) and the relay can refuse hosted actions at 100 % without SQL
([CT-ENTITLEMENTS](../../contracts/07-billing-entitlements.md) §5).

Code: `apps/api/src/modules/billing/quota/` (see its README) and the worker's
`apps/worker/src/jobs/quota-signals/`. Table: migration
`packages/db/migrations/20260102003900_quota_signal_state.sql`.

## What is measured

- **Limits:** the metered keys `hosted_minutes_month` (minutes hosted sessions spend live on the
  relay) and `queue_items_month` (queue submissions), from the workspace's entitlements (B069).
  `null` is unlimited and never evaluated. Other usage (tokens, agent minutes) is informational and
  never compared with a limit.
- **Usage:** B075's counters for the period: the entitlements' billing period when subscribed,
  else the UTC calendar month.
- **Hosted only:** a workspace without `relay_access` is not evaluated. LAN and local use never
  reach the backend, so they are never counted, signalled or blocked.
- **Levels:** `ok` below 80 %, `warn` from 80 % (`used × 100 ≥ limit × 80`), `reached` from 100 %
  (`used ≥ limit`). The comparison is in BigInt: no boundary depends on floating point. A limit of
  0 allows nothing: any use is `reached`, and it never warns.

## When it is evaluated

| Trigger      | How                                                                                                                                                                                                            | Delay                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Usage moved  | B075's aggregator (every 15 s) checks each workspace it touched; `withQuotaSignals` queues the workspace's `evaluate` job                                                                                      | 10 s debounce (`QUOTA_EVAL_DEBOUNCE_MS`): one evaluation per burst |
| Limits moved | B069 announces a new `rev` (`entitlements:invalidate`); `subscribeEntitlementChanges` queues `evaluate`                                                                                                        | 10 s debounce                                                      |
| Sweep        | the `sweep` job every 60 s (`QUOTA_SWEEP_INTERVAL_S`) queues every workspace whose quota meters moved in the last 35 days, whose signals have a delivery step to do, or whose period ended in the last 2 hours | the backstop                                                       |

A workspace has at most one `evaluate` job waiting or running (its job id is the workspace's), so
an update during a run waits for the next trigger or the sweep. From the aggregate update to the
notice on Redis takes about 10 s; the integration test holds it to 15 s at the 95th percentile.

## What an evaluation does

1. Reads the entitlements; none, or no `relay_access`, ends it (logged and counted).
2. In one transaction holding the workspace's lock (`pg_advisory_xact_lock(76,
hashtext(workspace_id))`):
   - re-reads the entitlements' `rev`; if it moved since step 1, the evaluation runs once more;
   - reads the period's counters, after the lock: decisions run one at a time, so the reading is
     never older than the one behind a level already claimed. A limit with no counter yet is
     unused. A limit that already signalled this period but has no counter is skipped (counters
     only grow within a period, so this is missing data, never a reason to re-arm);
   - **re-arms** a claimed level only when its limit was removed, or raised above the limit it was
     claimed under (kept on the row as `limit_value`), so usage is now below it: the row is
     deleted, and a later crossing in the same period signals again. A new period has no rows
     yet. A lower reading under the same limit changes nothing;
   - **claims** each level between what is still claimed and the current one: one
     `quota_signal_state` row per (workspace, limit, period start, level), so it fires at most
     once. A jump from 50 % to 130 % claims `warn` and then `reached`; a 0 limit's `reached`,
     re-armed by a raise that puts usage at 90 % of the new limit, claims `warn`;
   - writes `quota:state:{wsp}` (below) before the commit, so a reader sees the new level at once.
3. Delivers, after the commit, everything with a step still to do (below).

The evaluation answers the transitions it made, `{limit, from, to, pct}`.

## Delivery

Each signal has three steps, each marked in its row right after it succeeded:

| Step         | Column        | What                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notice       | `fired_at`    | `{code, level, params}` as JSON on the Redis channel `relay:notice:{wsp}`; the relay's fan-out (B044) sends it as `sys.notice` to every live hosted session of the workspace. `usage_warning` (level `warn`) `{pct: 80, resets_at}`; `quota_reached` (level `error`) `{resets_at}`. `resets_at` is the period's end, RFC 3339 UTC with milliseconds. |
| Notification | `notified_at` | B063's dispatcher, to the workspace's owners only: `usage_warning {limit, pct: 80}` or `quota_reached {limit}`, action `open_billing`, deduplicated per signal (workspace, limit, period, level and claim time, so a level claimed again after a re-arm is not taken for a repeat).                                                                  |
| Webhook      | `webhook_at`  | B081's `usage.threshold {limit, pct}` (pct 80 or 100).                                                                                                                                                                                                                                                                                               |

- Notices go out first and in order (`warn` before `reached`); a failure stops the later notices
  so the order holds. Notifications and webhooks then go out whatever happened to the notices: a
  dispatcher outage never delays a live-session notice, and the other way round.
- Delivery holds no transaction. It runs on one pooled connection holding the workspace's lock as
  a session lock (`pg_try_advisory_lock(76, hashtext(workspace_id))`, released when it ends, and
  with the connection if the process dies), and each mark is its own statement, committed right
  after its send. A lost connection or a slow send therefore never undoes the marks of sends that
  already went out (Postgres ends a session left idle inside a transaction after 15 s).
- A delivery that finds the lock taken, by another delivery or by a decision in progress, does
  nothing: the holder delivers after it, so ten concurrent evaluations send one notice.
- Every send gets 5 s (`QUOTA_SEND_TIMEOUT_MS`). A send that fails or does not answer in time fails
  its step, which the evaluation's job retries (5 attempts, backoff from 2 s with jitter), and
  after that the sweep; the steps that succeeded are not repeated.
- A decision waits for a running delivery, whose sends are bounded as above; one that waits past
  `statement_timeout` (10 s) fails, and its job retries.
- A signal whose period has ended is marked without being sent.
- Only the step in flight can go out twice: when the process dies or the connection is lost
  between a send and its mark, or when a send abandoned at its timeout completes after all. The
  notification's dedupe key absorbs a repeated notification (B063, within 10 minutes); a
  repeated notice or webhook event reaches its receivers twice (CT-WEBHOOKS lets deliveries
  arrive more than once, but the second event has its own delivery id).

Payloads carry ids, enums, 80 or 100, and `resets_at`: never the usage, the limit's size or text.
Logs carry the workspace id, the limit key, the level and error kinds only.

## The quota state flag

Redis hash `quota:state:{wsp}` (under the deployment's `ct:<env>:` prefix): one field per metered
limit, `ok`, `warn` or `reached`, expiring an hour after the period ends.

- Written by every evaluation, whole (DEL, HSET, PEXPIREAT in one MULTI), with B009's 2 s command
  timeout.
- `getQuotaState(workspaceId)` reads it; when it is missing, expired or unreadable, it answers
  from `quota_signal_state` for the current period and writes the hash only if it is still
  missing (one Lua script: EXISTS, then HSET and PEXPIREAT), so an older SQL reading never
  replaces the hash of an evaluation that wrote it meanwhile. SQL is authoritative; the hash can
  always be rebuilt.
- A write that fails drops the hash (readers then go to SQL) and fails the evaluation's job, which
  writes it again.
- `getWarnings(workspaceId)` is CT-ENTITLEMENTS' `warnings[]` (`warn` → pct 80, `reached` → pct
  100); `quotaWarningsReader` gives B069 the same from the stored signals of the period it asks
  about.

The rejection itself (429 `quota_exceeded`, pausing queue approvals and agent spawns) is B080's
and the relay's.

## Configuration

| Key                      | Default | Meaning                                                                                    |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `QUOTA_WARN_PCT`         | 80      | The warning threshold; CT-ENTITLEMENTS fixes it, so any other value is refused at startup. |
| `QUOTA_EVAL_DEBOUNCE_MS` | 10000   | How long an evaluation waits after usage moved (0 to 60000).                               |
| `QUOTA_SWEEP_INTERVAL_S` | 60      | Seconds between sweeps (10 to 3600).                                                       |

## Queues

`quota-signals`: jobs `evaluate {workspaceId}` and `sweep {}`, 5 attempts, exponential backoff
from 2 s with jitter. A job that failed every attempt is copied to `quota-signals.dead` (kept 7
days) and removed, which frees the workspace's job id for the next trigger. (The card names the
dead-letter queue `quota-signals:dead`; BullMQ refuses `:` in a queue name.)

## Metrics

| Metric                                 | Labels                                               |
| -------------------------------------- | ---------------------------------------------------- |
| `quota_signals_total`                  | `limit`, `level`: signals claimed                    |
| `quota_signals_rearmed_total`          | `limit`                                              |
| `quota_signal_deliveries_total`        | `step`: notice, notification, webhook                |
| `quota_signal_delivery_failures_total` | `step`                                               |
| `quota_evaluations_skipped_total`      | `reason`: no_entitlements, not_hosted, usage_missing |
| `quota_evaluations_rerun_total`        | none: the entitlements changed during an evaluation  |
| `quota_state_cache_failures_total`     | none                                                 |
| `quota_signal_jobs_failed_total`       | `job`: evaluate, sweep (dead-lettered)               |

## Retention

`quota_signal_state` keeps at most four rows per workspace and period; rows go with their
workspace. Removing old periods' rows is left to the retention jobs (B090).
