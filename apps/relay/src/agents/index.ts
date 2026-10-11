/**
 * The agent registry (B057, CT-WS-SESSION-EVENTS `agent.*`): each session's agents (id, owner,
 * mode, state, how they ended), who may control them, the spawn limit and the state rate limit.
 * The relay module is `module.ts` (order 39).
 */
export { createPostgresAgentEntitlements, ENTITLEMENT_CACHE_MS } from './entitlements.js';
export { agentStage } from './handler.js';
export type {
  AgentFrame,
  AgentMode,
  AgentOutcome,
  AgentRecord,
  AgentResult,
  AgentSender,
  AgentStore,
  AgentTx,
  DropReason,
  EntitlementsPort,
  SequenceStep,
  StateValidator,
  StoredAgent,
} from './ports.js';
export { AGENT_DETAILS, AgentRegistry, recordOf, type AgentRegistryDeps } from './registry.js';
export {
  createStateRateLimiter,
  STATE_FRAMES_PER_SECOND,
  type StateRateLimiter,
} from './state-rate-limit.js';
export {
  AGENT_DOC_TTL_MS,
  AGENT_LOCK_TTL_MS,
  AGENT_LOCK_WAIT_MS,
  createMemoryAgentStore,
  createRedisAgentStore,
  type AgentsDb,
  type RedisAgentStoreDeps,
} from './store.js';
