/**
 * The session lifecycle's ports (B053): what the service needs besides its repository, so it runs
 * against fakes in tests and against B080's entitlements, the relay and B081's webhooks in the API.
 *
 * - `EntitlementsPort`: B080's `check` (`relay_access`, `max_concurrent_sessions`), never a plan
 *   name. The service gives it 2 s.
 * - `RelayNotifierPort`: tells the relay a session's new state (`control.session_state`).
 * - `DomainEventsPort`: the `session.*` domain events (B081 fans them out to webhooks).
 *
 * Both notifications go out after the transition's commit, from the outbox; a failure is retried
 * with backoff (`SessionService.deliverOutbox`).
 *
 * Owns: the port types and the session type. Must not: hold an implementation.
 */
import type { SessionState } from './state-machine.js';

/** What an entitlement check decides (B080's CheckResult). */
export type EntitlementCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'flag_off' | 'count_reached' | 'quota_reached';
      retry_after_s?: number;
    };

/** B080's entitlement checks. */
export interface EntitlementsPort {
  check(
    workspaceId: string,
    key: 'relay_access' | 'max_concurrent_sessions',
    current?: number,
  ): Promise<EntitlementCheck>;
}

/** The relay. */
export interface RelayNotifierPort {
  /** The session `sid` is now in `state` (the relay emits `control.session_state`). */
  notify(sid: string, state: SessionState): Promise<void>;
}

/** A `session.*` domain event (CT-WEBHOOKS: `{session, host, name, state}`). */
export interface SessionDomainEvent {
  /** `evt_…`, fixed per outbox row so a redelivery is the same event. */
  id: string;
  type: 'session.created' | 'session.started' | 'session.ended';
  workspace: string;
  created_at: string;
  data: { session: string; host: string | null; name: string; state: SessionState };
}

/** Domain events. */
export interface DomainEventsPort {
  publish(event: SessionDomainEvent): Promise<void>;
}

/** A session's policy (CT-API-SESSIONS SessionPolicy; B051's `session_policy`). */
export interface SessionPolicyDefaults {
  auto_approve: 'ask' | 'trusted' | 'everyone';
  share_history: boolean;
  queue_limit: number;
  locked: boolean;
  auto_failover: boolean;
}

/** A session (CT-API-SESSIONS Session). */
export interface Session {
  id: string;
  workspace: string;
  name: string;
  state: SessionState;
  /** The host's session member (`mem_`). */
  host: string | null;
  policy: SessionPolicyDefaults;
  region: string;
  created_at: string;
  ended_at: string | null;
}
