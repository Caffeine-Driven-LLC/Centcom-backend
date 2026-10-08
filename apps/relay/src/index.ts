/**
 * @centcom/relay: WebSocket relay: sessions, sequencing, queue, presence, control. Routes
 * ciphertext only.
 *
 * Today: the service skeleton (B037): the server, health endpoints, configuration, metrics, the
 * module loader and frame pipeline relay lanes plug into, the connection registry, close codes
 * and graceful shutdown, plus member slots (B031), the connection state machine and
 * `closeConnection` (B040), session rooms with membership authorisation (B043), and sequencing:
 * `SeqStore`, acks and the hot buffer (B041). The process entrypoint is `main.ts`. Later lanes add
 * their folders with a `module.ts` each.
 */
export { buildInfo, type BuildInfo } from './build-info.js';
export { CloseCode, isCloseCode, type CloseCodeValue } from './close-codes.js';
export {
  DEFAULT_RELAY_MAX_CONNECTIONS,
  DEFAULT_RELAY_MAX_TRANSPORT_BYTES,
  DEFAULT_RELAY_PORT,
  DEFAULT_RELAY_SHUTDOWN_DRAIN_MS,
  loadRelayConfig,
  relayEnvSchema,
  type RelayConfig,
} from './config.js';
export {
  CLOSE_FRAMES,
  CLOSE_TERMINATE_MS,
  closeCodeFor,
  closeConnection,
  CloseSpecError,
  ERROR_CLOSE,
  type CloseFrame,
  type CloseSpec,
} from './connection/close.js';
export {
  DEFAULT_DEAD_MS,
  DEFAULT_PING_MS,
  heartbeatEnvSchema,
  loadHeartbeatConfig,
  type HeartbeatConfig,
} from './connection/config.js';
export {
  canTransition,
  CONN_STATES,
  createConnectionMachine,
  IllegalTransitionError,
  TRANSITIONS,
  type ConnectionMachine,
  type ConnState,
} from './connection/machine.js';
export {
  ConnectionRegistry,
  type ConnectionEntry,
  type ConnectionRegistryOptions,
  type ConnectionState,
} from './connection-registry.js';
export {
  dependencyProbe,
  handleHealth,
  Readiness,
  READINESS_INTERVAL_MS,
  READINESS_TIMEOUT_MS,
  type ReadinessChecks,
  type ReadinessProbe,
  type ReadinessReport,
} from './health.js';
export {
  closeLabel,
  createRelayMetrics,
  FRAME_TYPES,
  frameLabel,
  RELAY_METRICS,
  type RelayMetrics,
  type UpgradeRefusal,
} from './metrics.js';
export {
  discoverModules,
  ModuleError,
  MODULES_DIR,
  registerModules,
  sortModules,
  type RelayContext,
  type RelayDb,
  type RelayModule,
} from './modules.js';
export {
  FramePipeline,
  STAGE_ORDER,
  type FrameContext,
  type InboundStage,
  type RelayConnection,
} from './pipeline.js';
export {
  OVERLOAD_RETRY_AFTER_S,
  REFUSED_CLOSE_TIMEOUT_MS,
  RelayServer,
  startRelay,
  SUBPROTOCOL,
  sysBye,
  sysError,
  WS_PATH,
  type RelayServerOptions,
  type RunningRelay,
  type StartRelayOptions,
} from './server.js';
export {
  createShutdown,
  onShutdownSignals,
  SHUTDOWN_JITTER_MS,
  SHUTDOWN_REASON,
  type Shutdown,
  type ShutdownOptions,
  type SignalSource,
} from './shutdown.js';
export {
  DEFAULT_BUF_MAX_FRAMES,
  DEFAULT_BUF_MIN_AGE_S,
  DEFAULT_BUF_MIN_FRAMES,
  DEFAULT_SEQ_BURST,
  DEFAULT_SEQ_RATE,
  loadSeqConfig,
  seqEnvSchema,
  type SeqConfig,
} from './seq/config.js';
export { createMemorySeqStore, type MemorySeqStore } from './seq/memory-store.js';
export {
  createRedisSeqStore,
  createSeqRedisClient,
  seqKeys,
  type SeqRedisClientOptions,
} from './seq/redis-store.js';
export { BUFFER_TTL_MS, DEDUPE_TTL_MS } from './seq/retention.js';
export {
  SEQUENCED_STATE_KEY,
  SEQUENCED_TYPES,
  type AckTracker,
  type AssignResult,
  type BufferLimits,
  type DurableAppend,
  type SeqService,
  type SeqStore,
  type SequencedType,
  type StoredFrame,
  type UnsequencedFrame,
} from './seq/types.js';
export * from './slots/index.js';
export * from './rooms/index.js';
