/**
 * @centcom/testkit/sim (B011): scripted fake clients that speak the relay's WebSocket protocol,
 * so relay lanes are built and tested without the client repo. SimClient (one client), SimFleet
 * (up to 50), the scenario DSL, inbound faults, test relay tickets and their JWKS, frame builders,
 * and LoopbackRelay, the in-process reference server the simulator's own tests run against.
 * LoopbackRelay is exported here only, never from the package root.
 */
export {
  DEFAULT_TIMEOUT_MS,
  MAX_LOG_ENTRIES,
  SIM_CLIENT_INFO,
  SimClient,
  SimCloseError,
  SimTimeoutError,
  TERMINAL_CLOSE_CODES,
  type CloseInfo,
  type ConnectOpts,
  type SendResult,
  type Welcome,
} from './client.js';
export { createManualClock, systemClock, type Clock, type ManualClock } from './clock.js';
export { applyFaults, faults, REORDER_FLUSH_MS, type Fault, type FaultContext } from './faults.js';
export { MAX_FLEET, SimFleet } from './fleet.js';
export {
  buildFrame,
  checkFrame,
  describeIssues,
  dummySignature,
  FrameError,
  frameBytes,
  frameTypeOf,
  isSequencedType,
  MAX_FRAME_BYTES,
  opaqueCiphertext,
  payloadModeOf,
  PROTOCOL_DEFAULTS,
  PROTOCOL_VERSION,
  SEQUENCED_TYPES,
  SERVER_FIELDS,
  SUBPROTOCOL,
  withoutServerFields,
  type BuildFrameOptions,
  type Bytes,
  type Ciphertext,
  type Frame,
  type KindFrameType,
  type PayloadMode,
} from './frames.js';
export { LoopbackRelay, type LoopbackRelayOptions } from './loopback-relay.js';
export {
  Scenario,
  scenario,
  ScenarioError,
  type ScenarioClientOptions,
  type ScenarioContext,
  type ScenarioOptions,
  type ScenarioRun,
} from './scenario.js';
export {
  decodeTicket,
  mintTestTicket,
  TEST_KID_PREFIX,
  testJwks,
  TICKET_AUDIENCE,
  TICKET_ISSUER,
  TICKET_TTL_S,
  verifyTestTicket,
  type JsonWebKeySet,
  type SessionRole,
  type TestJwk,
  type TicketCheck,
  type TicketClaims,
  type TicketOptions,
  type TicketProblem,
} from './ticket.js';
