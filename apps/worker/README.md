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
