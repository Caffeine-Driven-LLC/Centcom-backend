/**
 * The host-loss policy (B053, CT-WS-CONTROL "Host failover"): what a session does when its host
 * has gone. Pure: the caller passes the times and, for failover, the connected editors (the relay
 * knows who is connected).
 *
 * - **Failover:** host absent for `FAILOVER_AFTER_MS` (120 s) and `auto_failover` on: the
 *   longest-connected editor (earliest `connectedSince`, then the lower member id) becomes the
 *   candidate. With no connected editor, or the flag off, there is none.
 * - **Pause:** a live session whose host has been absent for `HOST_GRACE_MS` (10 min) pauses
 *   (queue frozen) until the host returns or an admin claims host.
 * - **Expiry:** a session paused for `PAUSED_EXPIRY_MS` (24 h) expires.
 *
 * Owns: the thresholds and the choice. Must not: change anything (the service does).
 */

/** A host gone this long pauses its session (10 min). */
export const HOST_GRACE_MS = 10 * 60 * 1000;
/** A paused session expires after this long (24 h). */
export const PAUSED_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** A host gone this long may be replaced by an editor, when the policy allows (120 s). */
export const FAILOVER_AFTER_MS = 120 * 1000;

/** A connected editor, for failover. */
export interface ConnectedEditor {
  /** `mem_`. */
  memberId: string;
  /** When its current connection started (ms since the epoch). */
  connectedSince: number;
}

/** What the evaluator is told. */
export interface HostLossInput {
  /** When the host was last seen; null while the host is connected. */
  hostAbsentSince: number | null;
  /** Milliseconds since the epoch. */
  now: number;
  /** The policy's `auto_failover` (B051's `session_policy`; default off). */
  autoFailover: boolean;
  editors: readonly ConnectedEditor[];
}

/** What to do now. */
export interface HostLossDecision {
  /** The member to promote, or null. */
  failover: string | null;
  /** True once the grace is over (and nobody is promoted). */
  pause: boolean;
}

/** The decision for a session whose host may be gone. */
export function evaluateHostLoss(input: HostLossInput): HostLossDecision {
  if (input.hostAbsentSince === null) return { failover: null, pause: false };
  const absent = input.now - input.hostAbsentSince;
  if (absent >= FAILOVER_AFTER_MS && input.autoFailover && input.editors.length > 0) {
    const [first] = [...input.editors].sort(
      (a, b) => a.connectedSince - b.connectedSince || a.memberId.localeCompare(b.memberId),
    );
    if (first !== undefined) return { failover: first.memberId, pause: false };
  }
  return { failover: null, pause: absent >= HOST_GRACE_MS };
}

/** True when a live session whose host was last seen at `lastSeen` is due to pause at `now`. */
export const dueForPause = (lastSeen: number, now: number): boolean =>
  now - lastSeen >= HOST_GRACE_MS;

/** True when a session paused at `pausedAt` is due to expire at `now`. */
export const dueForExpiry = (pausedAt: number, now: number): boolean =>
  now - pausedAt >= PAUSED_EXPIRY_MS;
