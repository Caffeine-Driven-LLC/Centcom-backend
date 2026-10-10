# Data retention (B090)

Every stored dataset has a retention rule (GUIDELINES §5.7). A nightly job deletes what is past
its rule, in batches, behind safety brakes; deleting a workspace purges its history at once.
Session history and audit events follow the workspace's plan
([CT-ENTITLEMENTS](../../contracts/07-billing-entitlements.md) `history_days`, shortened by the
workspace's retention override, and `audit_log_days`), and a shortened retention never deletes at
once: history gets 7 days' notice, audit 7 days' wait
([CT-RESUME](../../contracts/03-ws-envelope.md) "Deletion and retention"; CT-ENTITLEMENTS "On
downgrade: no data is deleted immediately").

Code: the worker's `apps/worker/src/jobs/retention/` (policies, runner, queue) and the SQL in
`@centcom/db`'s `repos/retention.ts`. Tables: migration
`packages/db/migrations/20260102004200_retention.sql`.

## What is deleted, and when

| Policy                | Dataset (owner)                                 | Deleted                                                                                            | Brake |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----- |
| `history`             | durable session history (B055)                  | ended or expired sessions' blobs, index and retention rows, `history_days` after the session ended | yes   |
| `audit`               | `audit_events` (B036)                           | a workspace's events older than its `audit_log_days` (0: all), through `purge_audit_events()`      | yes   |
| `audit_staff_details` | `staff_audit_details` (B087)                    | details whose audit event is gone                                                                  | no    |
| `webhook_log`         | `webhook_events`, `webhook_deliveries` (B081)   | events created over 30 days ago, with their deliveries                                             | yes   |
| `notifications`       | `notifications` (B063)                          | created over 90 days ago (the inbox stopped showing them at 90 days)                               | yes   |
| `refresh_tokens`      | `refresh_tokens` (B017)                         | whole token families past their absolute expiry (180 days)                                         | yes   |
| `login_tokens`        | `login_tokens` (B014)                           | past their expiry (they live 15 minutes and are used once)                                         | no    |
| `device_codes`        | `device_grants` (B016)                          | 10 minutes past their expiry, whatever their status                                                | no    |
| `invites`             | `invites` (B029)                                | accepted, revoked or expired over 30 days ago (their key bundles went at once)                     | yes   |
| `api_keys`            | `api_keys` (B019)                               | revoked or expired over 30 days ago                                                                | yes   |
| `account_exports`     | `account_exports` (B026)                        | rows expired (B026's sweep deleted the file at 7 days) or failed, over 30 days ago                 | yes   |
| `audit_exports`       | `audit_export_jobs` (B082)                      | rows expired (B082's sweep deleted the file) or failed, over 30 days ago                           | yes   |
| `stripe_events`       | `stripe_event` (B072)                           | processed or ignored, received over 90 days ago                                                    | yes   |
| `billing_outbox`      | `billing_outbox` (B072)                         | published over 30 days ago                                                                         | yes   |
| `billing_trials`      | `billing_trials`, `billing_trial_owners` (B079) | 24 months after the trial ended (or was recorded, when Stripe gave no end)                         | yes   |
| `retention_runs`      | `retention_runs` (B090)                         | this job's run reports, finished over 90 days ago                                                  | yes   |
| `telemetry`           | `telemetry_events` (B085)                       | nothing: reports the raw events still stored past 90 days (B085's job drops them)                  | n/a   |

Other lanes add theirs as extra policies (`createRetentionPolicies({ extra })`), run after these:
B026's account purge finaliser, if it ever needs one, B068's share links, B056's snapshots if they
need more than the snapshot store the history policy already calls.

Expired elsewhere, not by this job:

- **Idempotency keys** (B024, 24 h: `packages/core/test/idempotency/expiry.test.ts`), **revoked
  access-token `jti`s** and the relay's spent relay-ticket `jti`s live in Redis with a TTL of their
  token's lifetime.
- **Export files**: account exports' files (B026's sweep, 7 days) and audit export objects (B082's
  sweep, 24 h to 7 days by type). This job deletes their rows after.
- **Telemetry** (B085): its own daily partition drops (90 days); the `telemetry` policy reports
  what is overdue, read-only.
- **Share links** (B068) and **snapshots** (B056) have no storage yet. The history policy and
  `purgeWorkspace` take B056's snapshot store as soon as it exists (`snapshots`).
- **Audit events outside any workspace** (account-level actions) have no `audit_log_days`; they are
  kept until a rule is decided.

## Session history

- **Which sessions:** only `ended` or `expired` sessions with an end time. `pending`, `live` and
  `paused` sessions are never purged, whatever their age, and sessions outside any workspace are left
  alone. A due session holding only blobs or a retention row (an append or purge that died half
  way) is purged too.
- **How long:** the effective `history_days`: the plan's (free 0, Pro 7, Team 30), or the
  workspace's retention override (`retention_days`) when that is smaller. An override never lengthens
  retention: 30 on a 7-day plan gives 7, 3 gives 3.
- **Purging:** through B055's history store, a session at a time (4 at once): blobs first, then the
  index rows, then the retention row, so no row outlives a blob that failed to go. A session whose
  blob delete fails is left with its remaining rows and retried the next night. A store that
  throttles (HTTP 429 or 503) halves the concurrency, and the session is retried after a backoff
  (1 s, doubling, with jitter; 3 times a run).
- **Entitlements unavailable:** the workspace is skipped this run, with a warning, and never taken
  for 0 days.

### Shortened retention: never at once

The job keeps the days it enforces per workspace and dataset (`retention_baseline`, `history` and
`audit`). When the effective days drop below them (a downgrade, or a shorter override):

1. it records a pending shortening (`retention_pending`: old days, new days, `effective_at` = 7 days
   later) and keeps enforcing the old days until then;
2. for history, it publishes `sys.notice` `history_retention_changed {days}` (level `info`) on the
   Redis channel `relay:notice:{wsp}`, which the relay's fan-out sends to every live session of the
   workspace, and emails each active owner (`history_retention_changed` template: the workspace's
   name, the new days, the date), with an idempotency key per shortening, so a retry is not
   delivered twice. Audit has no notice: no code exists for it, and the plan change itself is
   announced.

The notice and the email are each marked once sent, with the time they went out (the wall clock,
not the run's start); one that fails is retried the next night, without repeating the other. A
history shortening applies only once both went out, 7 days after the later of the two (so a late
email, or a run that reached the workspace late, moves the purge later, never cuts the notice
short); an audit shortening applies at `effective_at`. A run applies it when it starts at most 4
minutes before that time, so a nightly run that starts a little early in its slot still applies it;
a notice that went out later in its run than that applies a night later.

Retention back to the old days or more before then withdraws the shortening and enforces the new
days at once; a further drop restarts the 7 days (and the notice); a partial rise keeps them. Longer
retention takes effect at once. A workspace the job sees for the first time takes its effective days
as they are, without notice: the job has no record of what it kept before. So a downgrade that
happened before a workspace's first live run (including the first live run after a dry-run period)
applies at once; only changes the job has seen get the 7 days.

The shortening is recorded at the first nightly run after the change, so the purge for it happens 7
to 9 days after the change: 7 nights after it was recorded, or 8 when the run reached the workspace
more than 4 minutes after it started (or the email went out a night late).

## Deleting a workspace

`purgeWorkspace(workspaceId)` purges the history (and snapshots, later) of every session of the
workspace, whatever its state, and writes a `history.purge` audit event with the counts (`frames`,
`blobs`; actor `system`/`retention`; target the workspace; outside the workspace, because B027's
purge deletes the workspace's own events next). A retry that finds nothing left writes no second
event. It runs as B027's `retention` purge hook, or as the `retention` queue's `purge-workspace`
job. Register it in place of B055's `history` hook, which purges the same history without the audit
event (or before it: the hook that runs first does the purge and the counting).

## Safety brakes

- **Batches:** 1 000 rows per statement (refresh tokens: whole families, about 1 000 rows at a
  time, at least one family); history a session at a time, 4 at once (B055's store deletes a
  session's blobs one at a time, so at most 4 blobs are in flight).
- **Budget:** one run has 30 minutes for every policy, run one after another. A policy that runs out
  stops cleanly (between workspaces, pages or rounds), reports `budget_exceeded` and its backlog
  (`retention_backlog{policy}`), and the next night continues. The history and audit policies
  decide workspace by workspace first, for at most half of their budget, then act on what they
  decided with the rest, so a night that runs out while deciding still purges the workspaces it
  decided. Their backlog counts only what they decided and left. They go through the workspaces in
  id order from a cursor (`retention:cursor:<policy>` in Redis, 3-day TTL): a run that stops leaves
  it after the last workspace it finished, the next run starts there and wraps around to the first
  id, and a run that went all the way round clears it. A lost cursor only means the next run starts
  at the first id. A dry run reads it and never moves it. Policies run in a fixed order, so while
  history has a backlog it can use the night's budget before the later policies run.
- **Fraction brake:** a policy that would delete more than `RETENTION_MAX_DELETE_FRACTION` (20 %) of
  its table in one run aborts before deleting anything, with `aborted_reason = 'fraction_exceeded'`
  and `retention_aborted_total{policy,reason}`, unless `RETENTION_FORCE` is set. It is off for
  `login_tokens` and `device_codes`, whose rows live minutes (almost all are due every night), and
  for `audit_staff_details`, which only follows the `audit` policy's deletions. The history and
  audit brakes cover the workspaces decided that night. The `audit` brake leaves out the workspaces
  that already kept no audit log before the run (`audit_log_days = 0` recorded, nothing pending), and
  new ones seen for the first time at 0 days whose events are all younger than 2 days: everything
  they wrote since the last run is due every night by design. A workspace whose events would all go
  for the first time (a shortening to 0 that applies that night, or old events first seen at 0 days)
  stays under it. A table's total is exact up to 100 000 rows and the planner's estimate above, so
  the brake never scans a large table whole; when the estimate is below the audit events already
  known due at 0 days, the brake compares with the whole table instead of subtracting them. A first
  run on old data, or a big planned change, may need one forced run.
- **Dry run:** `RETENTION_DRY_RUN` (on by default outside production) counts what is due, deletes and
  writes nothing (no bookkeeping, notice or email), and reports with `dry_run = true`. It checks the
  brake too and reports a would-be abort in its row, without counting it in
  `retention_aborted_total` (non-production never deletes, so it would abort every night).
- **One run per policy:** a Redis lock per policy (`retention:lock:<policy>`, 60-second TTL renewed
  every 15 seconds while the policy runs). A dead worker's lock expires within a minute; the job's
  first retry comes at least 90 seconds later.

## Run reports

`retention_runs` holds one row per policy per run: `policy`, `started_at`, `finished_at`,
`scanned`, `purged`, `skipped`, `dry_run`, `aborted_reason` (`fraction_exceeded`,
`budget_exceeded`, `failed`, or `interrupted` for a run whose worker died, closed by the next run of
the policy). `scanned` counts what was due (history: frames; telemetry: overdue events), `purged`
what was deleted, `skipped` what was due but left (history: the frames of sessions whose purge
failed). Reports finished over 90 days ago are purged by the `retention_runs` policy.

Logs carry counts, policy names, workspace ids and error kinds; never session ids or any content. A
cursor that cannot be read or written logs `retention.cursor_failed` at warn and the run goes on.

## Queue

`retention`, worker concurrency 1:

- `run {policy?}`: every policy, or one. Scheduled daily at 03:00 UTC. A run in which a policy failed
  or found its lock taken fails after the others ran and is retried (5 attempts, exponential backoff
  from 3 minutes with jitter); a brake or a spent budget is not a failure.
- `purge-workspace {workspaceId}`: `purgeWorkspace`, 5 attempts from 10 s.

Jobs that failed every attempt stay in the failed set (the dead-letter set) for 7 days.

## Configuration

| Key                             | Default                         | Meaning                                                           |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `RETENTION_DRY_RUN`             | on unless `NODE_ENV=production` | Count only; delete and write nothing.                             |
| `RETENTION_FORCE`               | off                             | Let a run delete more than the brake allows.                      |
| `RETENTION_MAX_DELETE_FRACTION` | 0.2                             | Largest share of a table one run may delete (above 0, at most 1). |

## Metrics

| Metric                               | Labels                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| `retention_purged_total`             | `policy`                                                  |
| `retention_run_duration_seconds`     | `policy` (histogram)                                      |
| `retention_aborted_total`            | `policy`, `reason` (B094's `RetentionJobFailed` reads it) |
| `retention_backlog`                  | `policy` (gauge: left by a spent budget)                  |
| `retention_policy_failures_total`    | `policy`                                                  |
| `retention_purge_failures_total`     | `policy`: one session's purge failed                      |
| `retention_throttled_total`          | `policy`: blob deletes throttled                          |
| `retention_workspaces_skipped_total` | `policy`, `reason`: entitlements failed or unavailable    |
| `retention_notice_failures_total`    | `step`: notice, email                                     |
| `retention_jobs_failed_total`        | `job`: dead-lettered                                      |

The failure counters are recorded only when something fails (`onFailure` in the catalogue). The
alert on aborted runs is B094's `RetentionJobFailed` (`infra/alerts/rules/retention.rules.yaml`,
runbook `infra/runbooks/alerts/RetentionJobFailed.md`).

## Wiring

```ts
const repo = createRetentionRepository(db); // @centcom/db
const historyStore = createHistoryStore({ db, blobs }); // B055
registerRetentionTemplates(emailService.templates); // B032
const runner = new RetentionRunner({
  policies: createRetentionPolicies({
    cursor: createDecideCursor(redis.kv), // B009
    stores: {
      state: repo.state,
      history: repo.history,
      audit: repo.audit,
      telemetry: repo.telemetry,
      rows: repo.rows,
    },
    history: historyStore,
    entitlements, // B069's EntitlementService
    notices: redis.pubsub, // B009
    mailer: emailService,
    logger,
    metrics,
  }),
  lock: createPolicyLock(redis.kv),
  runs: repo.runs,
  config: loadRetentionConfig(),
  logger,
  metrics,
});
observeRetentionBacklog(telemetryMetrics, runner);
const purger = createWorkspacePurger({ sessions: repo.sessions, history: historyStore, audit });
registerRetentionPurgeHook(purgeHooks, purger); // B027's workspace purge, instead of B055's hook
const queue = createRetentionQueue({ connection, prefix });
await scheduleRetention(queue);
startRetentionWorker({ connection, prefix, runner, purger, logger, metrics });
```

Deployment: `purge_audit_events()` is executable by the table owner only; where the worker runs as
another role, `grant execute on function purge_audit_events(text, timestamptz, integer) to
<worker role>`.
