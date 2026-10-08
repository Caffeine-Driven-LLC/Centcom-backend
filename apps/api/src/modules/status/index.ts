/**
 * Health and the public status feed (B086, CT-STATUS): readiness checks, component probes with
 * hysteresis, the cached feed, and incidents and deprecations for B087's admin tooling. Routes in
 * `routes/status.ts`. See README.md.
 */
export {
  FAILURES_FOR_OUTAGE,
  INITIAL_PROBE_STATE,
  nextProbeState,
  STATUS_ORDER,
  SUCCESSES_FOR_RECOVERY,
  worstOf,
  type ComponentStatus,
  type ProbeState,
} from './aggregate.js';
export {
  loadStatusConfig,
  MAX_COMPONENTS,
  statusEnvSchema,
  type ComponentProbe,
  type StatusComponent,
  type StatusConfig,
} from './config.js';
export {
  ComponentProber,
  httpUp,
  PROBE_ROUND_MS,
  PROBE_TIMEOUT_MS,
  probeKey,
  probeStateKey,
  type ComponentReport,
  type ProberDeps,
} from './prober.js';
export { Readiness, type ReadinessChecks, type ReadinessReport } from './readiness.js';
export {
  createStatusRepository,
  type DeprecationRecord,
  type IncidentRecord,
  type StatusRepository,
} from './repository.js';
export {
  FEED_STALE_MS,
  FEED_TTL_MS,
  MAX_FEED_BYTES,
  MIN_CLIENT_VERSION_KEY,
  StatusAdmin,
  StatusFeed,
  type FeedSnapshot,
  type Incident,
  type StatusBody,
} from './service.js';
