/**
 * Session lifecycle (B053, CT-API-SESSIONS): session rows and their state machine (live, paused,
 * ended, expired), host-loss pause, 24 h expiry, failover eligibility, the concurrent-session limit
 * and the transition outbox. B054 adds the routes; the worker runs `session.expiry.sweep`.
 */
export {
  dueForExpiry,
  dueForPause,
  evaluateHostLoss,
  FAILOVER_AFTER_MS,
  HOST_GRACE_MS,
  PAUSED_EXPIRY_MS,
  type ConnectedEditor,
  type HostLossDecision,
  type HostLossInput,
} from './host-loss.js';
export {
  DEFAULT_SESSION_POLICY,
  ENTITLEMENTS_RETRY_AFTER_S,
  ENTITLEMENTS_TIMEOUT_MS,
  OUTBOX_BASE_DELAY_MS,
  OUTBOX_BATCH,
  OUTBOX_MAX_DELAY_MS,
  SESSION_DETAILS,
  SessionService,
  SWEEP_BATCH,
  toSession,
  type Actor,
  type CreateSessionInput,
  type SessionServiceDeps,
} from './lifecycle.js';
export type {
  DomainEventsPort,
  EntitlementCheck,
  EntitlementsPort,
  RelayNotifierPort,
  Session,
  SessionDomainEvent,
  SessionPolicyDefaults,
} from './ports.js';
export {
  createSessionRepository,
  SWEEP_LOCK_KEY,
  type ListQuery,
  type NewSession,
  type OutboxRow,
  type SessionRepository,
  type SessionRow,
  type SessionsDb,
  type StoredSession,
} from './repository.js';
export {
  isFinal,
  LIFECYCLE_EVENTS,
  SESSION_STATES,
  SessionStateError,
  sourcesOf,
  transition,
  type LifecycleEvent,
  type SessionState,
} from './state-machine.js';
