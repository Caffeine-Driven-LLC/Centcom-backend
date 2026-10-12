/**
 * Presence history (B067): when members came online and went offline, and when they were last
 * seen; lookups for other backend lanes, never a route. See README.md.
 */
export { createPresenceHistoryModule } from './module.js';
export * from './ports.js';
export { purgeOlderThan, PURGE_BATCH, retentionCutoff } from './purge.js';
export {
  createPostgresHistoryWriter,
  createPostgresPresenceHistory,
  type PresenceHistoryDb,
} from './queries.js';
export {
  createConnectionEvents,
  PresenceHistoryRecorder,
  reasonOf,
  type HistoryTimer,
  type RecorderDeps,
} from './recorder.js';
