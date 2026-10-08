# @centcom/worker

BullMQ jobs on Redis (ARCHITECTURE: "Workers"). Each job lives in `src/jobs/` and is exported from
`src/index.ts`. Every job retries with backoff and jitter and has a dead-letter path
(GUIDELINES §6.2).

## `email-send` (B032)

Delivers the emails `EmailService.send` (`@centcom/core`) queued.

```ts
import { Redis } from 'ioredis';
import { createEmailProvider, emailConfig } from '@centcom/core';
import { startEmailWorker } from '@centcom/worker';

const config = emailConfig();
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null }); // BullMQ needs null here
const worker = startEmailWorker({
  connection,
  prefix: 'ct:production:bull',
  provider: createEmailProvider(config, logger),
  kv: redis.kv,
  timeoutMs: config.timeoutMs,
  logger,
  metrics,
});
// on shutdown: await worker.close();
```

- **Timeout:** each provider call is cut off after `EMAIL_TIMEOUT_MS` (10 s by default).
- **Retries:** up to 5 attempts. The wait after the n-th failure is half to all of
  30 s · 2^(n-1), at most an hour, or as long as the provider's Retry-After asks.
- **Dead letters:**
  - The 5th failure leaves the job in the queue's failed set (kept for 7 days) and counts
    `email_failed_total{template}`.
  - Permanent rejections (4xx but 429) fail at once, with `email_rejected_total{template}`
    too.
  - Delivered jobs leave Redis at once.
- **Exactly one send per job:** a delivered job is remembered for 24 h, so a job BullMQ hands out
  again (a stalled worker) sends nothing more.
- **Logs:** template, job id and provider message id only: `email.sent`, `email.rejected`,
  `email.retry`, `email.failed`. Worker errors are logged by name only.
- **Dependencies:** `bullmq` brings `msgpackr`, whose optional `msgpackr-extract` has an install
  script. The workspace's `ignoreScripts: true` blocks it, and msgpackr loads a prebuilt binary
  for the platform when present, else works in plain JS.
- **Tests:** `test/email-send.test.ts`.
  - Locally: the processor, the backoff and the dead-letter accounting.
  - On Redis 7 (CI's integration job): delivery through the service, idempotency end to end, 5
    attempts then the dead-letter set, a permanent rejection, and a Retry-After wait.

## `workspace-purge` (B027)

Removes a workspace the API deleted (and hid at once). For each job `{workspaceId}`:

1. announces `workspace.deleted` on `centcom:workspace-events` again;
2. runs the purge hooks in registration order (`registry.register(name, hook)`: session history,
   snapshots, billing wind-down; each must be idempotent);
3. hard-deletes the workspace's audit events (through `purge_audit_events`), sessions,
   memberships and row (@centcom/db `createWorkspaceStore(db).purge`; a live workspace is refused).

```ts
const hooks = createPurgeHookRegistry();
hooks.register('history', purgeHistory); // later lanes
const worker = startWorkspacePurgeWorker({
  connection,
  prefix,
  hooks,
  store: createWorkspaceStore(db),
  events: redis.pubsub,
  logger,
  metrics,
});
```

- **Retries:** 5 attempts, waiting between half and all of `10 s · 2^(n-1)` (at most 10 min);
  then the job stays in the failed set (dead letter, kept 7 days), counted in
  `workspace_purge_failed_total` and logged as `workspace.purge_failed`.
- **Idempotent:** a job run twice purges once; the second run's store purge finds nothing.
- **Logs:** workspace ids, hook names and error kinds only.

## `invite-expiry` (B029)

Every 5 minutes, marks lapsed pending invites expired and drops their key bundles, and drops key
bundles past their own time (15 minutes after acceptance, never fetched): a bundle outlives its
invite by 5 minutes at most. The same file registers the `invites` purge hook, which deletes a
purged workspace's invites before `workspace-purge` removes its row.

```ts
const queue = createInviteExpiryQueue({ connection, prefix });
await scheduleInviteExpiry(queue); // one scheduler per queue, however often it is called
const worker = startInviteExpiryWorker({
  connection,
  prefix,
  store: createInviteStore(db),
  logger,
  metrics,
});
registerInvitePurgeHook(hooks, createInviteStore(db)); // before startWorkspacePurgeWorker
```

- **Idempotent:** a run changes only what is due, so a repeated or overlapping run is harmless.
- **Retries:** 3 attempts (`inviteExpiryJobOptions()`, on the queue's defaults and the
  scheduler's template), waiting between half and all of `10 s · 2^(n-1)` (BullMQ's exponential
  backoff, jitter 0.5); then the run stays in the failed set (dead letter, kept 7 days), counted
  in `invite_expiry_failed_total` and logged as `invite.expiry_failed`. The next scheduled run
  comes all the same: BullMQ queues it when a run starts.
- **Metrics and logs:** `invites_expired_total`, `invite_key_bundles_dropped_total`,
  `invite_expiry_failed_total`; `invite.expiry_swept` with the counts only, and
  `invite.expiry_retry` / `invite.expiry_failed` with the job id, the attempts and the error's
  kind. Bundles are never read or logged.
- **Tests:** `test/invite-expiry.test.ts`: the processor, the schedule, the retries and dead
  letter, and the purge hook; on Redis 7 (CI), one scheduler with the retry options, a run, and a
  failing run dead-lettered after 3 attempts.

## `workspace-settings` purge hook (B034)

`registerWorkspaceSettingsPurgeHook(hooks, store)` adds the `workspace-settings` hook to B027's
purge registry: it deletes a purged workspace's settings row before `workspace-purge` removes the
workspace row (the row's foreign key restricts the delete). It is idempotent, and does nothing for
a live workspace.

```ts
registerWorkspaceSettingsPurgeHook(hooks, createWorkspaceSettingsStore(db)); // before startWorkspacePurgeWorker
```

- **Tests:** `test/workspace-settings-purge.test.ts`: the hook runs before the purge, twice
  harmlessly, and its name is taken once.

## `projects` purge hook (B035)

`registerProjectPurgeHook` adds the `projects` hook to B027's purge registry: it deletes a purged
workspace's projects (`deleteForWorkspace`) before `workspace-purge` removes the workspace row,
which the foreign key requires. Like every hook it is idempotent.

```ts
registerProjectPurgeHook(hooks, createProjectStore(db)); // before startWorkspacePurgeWorker
```

Tests: `test/projects.purge-hook.test.ts` (registration, order before the purge, a harmless
re-run); the rows going on Postgres is checked in
`apps/api/test/modules/projects/projects.postgres.test.ts`.

## `notify.dispatch` and `notify.digest` (B063)

The BullMQ side of the notification dispatcher
([README](../api/src/modules/notifications/dispatcher/README.md)). The processing is injected:
`process` is the API's `NotificationDispatcher.process`, `run` its `runDigest`.

```ts
const deadLetter = createNotifyDeadLetterQueue({ connection, prefix });
startNotifyDispatchWorker({
  connection,
  prefix,
  deadLetter,
  process: (job) => dispatcher.process(job),
});
const digest = createNotifyDigestQueue({ connection, prefix });
await scheduleNotifyDigest(digest); // one hourly schedule per queue
startNotifyDigestWorker({ connection, prefix, run: () => runDigest({ store, email }) });
```

- **Dispatch:** 5 attempts, exponential backoff from 5 s with jitter 0.5; after the last, the
  event is copied to `notify.dispatch.dlq` (job `dead-<event id>`, kept 7 days) for an operator to
  replay, counted in `notification_dispatch_failed_total` and logged by error kind only.
  Dispatching is idempotent, so a retry only finishes a partial run.
- **Digest:** hourly, one run at a time, 3 attempts; a run is idempotent.
- **Tests:** `test/notify-dispatch.test.ts`: options, dead-lettering, and on Redis 7 (CI) a
  dispatch failing 5 times into the dead-letter queue and the hourly schedule.
