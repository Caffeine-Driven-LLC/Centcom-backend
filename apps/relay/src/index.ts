/**
 * @centcom/relay: WebSocket relay: sessions, sequencing, queue, presence, control. Routes
 * ciphertext only.
 *
 * Today: the service skeleton (B037): the server, health endpoints, configuration, metrics, the
 * module loader and frame pipeline relay lanes plug into, the connection registry, close codes
 * and graceful shutdown, plus member slots (B031). The process entrypoint is `main.ts`. Later
 * lanes add their folders with a `module.ts` each.
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
export * from './slots/index.js';
