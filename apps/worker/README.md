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
