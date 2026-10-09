/**
 * Resume and replay (B042): a reconnecting client's missed frames from the hot buffer or the
 * durable log, `sys.resumed`, the live-frame handoff, and recovery of sessions lost from Redis. The
 * relay module is `module.ts` (order 45).
 */
export {
  DEFAULT_HYDRATE_FRAMES,
  DEFAULT_REPLAY_BATCH,
  DEFAULT_REPLAY_MAX_FRAMES,
  loadResumeConfig,
  resumeEnvSchema,
  type ResumeConfig,
} from './config.js';
export { historyDurableAppend, historyLogReader, relayFrameOf } from './durable-log.js';
export {
  createHydrator,
  HYDRATE_MAX_BYTES,
  MAX_KNOWN_SESSIONS,
  type Hydrator,
  type HydratorDeps,
} from './hydrate.js';
export {
  createResumer,
  DRAIN_POLL_MS,
  RESUME_BUCKETS_S,
  RESUME_DETAILS,
  STALL_MS,
  type Resumer,
  type ResumerDeps,
} from './resume.js';
export {
  noDurableLog,
  noSnapshots,
  type DurableLogReader,
  type ResumeResult,
  type SnapshotLookup,
} from './types.js';
