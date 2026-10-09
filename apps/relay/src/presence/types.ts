/**
 * Presence types (B047, CT-WS-PRESENCE): the clear payload of `presence.update`, what the store keeps
 * per member, and the service the module offers (`ctx.presence`).
 *
 * Owns: these shapes. Must not: describe a field beyond `status`, `activity` and `agent_count`.
 */

/** The kind this lane handles; other presence kinds (cursor, nudge) are B048's. */
export const PRESENCE_UPDATE = 'presence.update';

/** `presence.update.p` (CT-WS-PRESENCE; there is no `offline` on the wire). */
export interface PresenceUpdate {
  status: 'online' | 'away' | 'busy';
  activity: 'idle' | 'typing' | 'reviewing' | 'running';
  agent_count?: number;
}

/** A member's latest presence as stored: the payload, when it went out, and from which node. */
export interface PresenceEntry {
  p: PresenceUpdate;
  /** Milliseconds since the epoch. */
  at: number;
  node: string;
}

/** `ctx.presence` (card B047). */
export interface PresenceService {
  /** Member `mid` of `sid` sent `p` at `nowMs`: kept as the latest, fanned out within the limits. */
  update(sid: string, mid: string, p: PresenceUpdate, nowMs: number): void;
  /** The latest presence of each member of `sid` this node knows (local and stored). */
  snapshot(sid: string): { member: string; p: PresenceUpdate }[];
  /** True while `mid` has a connection here, or lost its last one less than the grace ago. */
  isOnline(sid: string, mid: string): boolean;
  onConnect(sid: string, mid: string): void;
  onDisconnect(sid: string, mid: string): void;
}
