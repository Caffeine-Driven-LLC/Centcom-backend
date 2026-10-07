/**
 * Test helpers for email (B032): a queue that records what it is given (and can fail), a service
 * over B009's in-memory backend on a fake clock, and template parameters whose links carry a token
 * made at run time (so tests can prove it never reaches a log).
 */
import { randomBytes } from 'node:crypto';
import {
  createEmailService,
  createMemoryRedis,
  type EmailJobData,
  type EmailJobOptions,
  type EmailQueue,
  type EmailService,
  type EmailServiceOptions,
  type TemplateParams,
} from '../../src/index.js';
import { captureLogger, countingMetrics, FakeClock } from '../redis/helpers.js';

export { captureLogger, countingMetrics, FakeClock };

interface QueuedJob {
  name: string;
  data: EmailJobData;
  jobId: string;
  opts: EmailJobOptions;
}

/** A queue that keeps every job, refuses a job id it already holds (like BullMQ), and can fail. */
export function recordingQueue(): EmailQueue & { jobs: QueuedJob[]; down: boolean } {
  const queue = {
    jobs: [] as QueuedJob[],
    down: false,
    add(name: string, data: EmailJobData, opts: EmailJobOptions) {
      if (queue.down) return Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:6379'));
      if (!queue.jobs.some((job) => job.jobId === opts.jobId)) {
        queue.jobs.push({ name, data, jobId: opts.jobId, opts });
      }
      return Promise.resolve({ id: opts.jobId });
    },
  };
  return queue;
}

/** A secret-looking link token, made at run time. */
export const token = (): string => randomBytes(20).toString('base64url');

/** Parameters for each template; links carry a fresh token. */
export const params = {
  workspace_invite: (): TemplateParams['workspace_invite'] => ({
    inviterName: 'Ada Lovelace',
    workspaceName: 'Analytical Engines',
    url: `https://centcom.dev/i/${token()}`,
    expiresAt: new Date('2026-10-14T12:00:00Z'),
  }),
  account_deletion_scheduled: (): TemplateParams['account_deletion_scheduled'] => ({
    displayName: 'Ada',
    deletionDate: new Date('2026-11-06T12:00:00Z'),
    restoreUrl: `https://centcom.dev/account/restore?t=${token()}`,
  }),
  export_ready: (): TemplateParams['export_ready'] => ({
    displayName: 'Ada',
    url: `https://centcom.dev/exports/${token()}`,
    expiresAt: new Date('2026-10-08T12:00:00Z'),
  }),
};

/** A service over a recording queue and an in-memory backend, with everything it touches. */
export function setup(overrides: Partial<EmailServiceOptions> = {}): {
  service: EmailService;
  queue: ReturnType<typeof recordingQueue>;
  backend: ReturnType<typeof createMemoryRedis>;
  clock: FakeClock;
  log: ReturnType<typeof captureLogger>;
  counters: ReturnType<typeof countingMetrics>;
} {
  const clock = new FakeClock();
  const backend = createMemoryRedis(clock.read);
  const queue = recordingQueue();
  const log = captureLogger();
  const counters = countingMetrics();
  const service = createEmailService({
    queue,
    rateLimit: backend.rateLimit,
    kv: backend.kv,
    from: 'Centcom <no-reply@centcom.test>',
    logger: log.logger,
    metrics: counters.metrics,
    ...overrides,
  });
  return { service, queue, backend, clock, log, counters };
}
