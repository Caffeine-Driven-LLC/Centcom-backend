/**
 * The live checks behind a ticket (B038's `SessionAccess` port; B043 provides the Postgres
 * implementation): does the session exist and is it not ended, is the member still a member, is
 * the device live, does the workspace's plan include the relay (`relay_access`, CT-ENTITLEMENTS)?
 * The membership record, not the ticket, decides the role (CT-RBAC rule 3).
 *
 * Until B043 plugs its implementation in, the relay uses `unavailableSessionAccess`: every
 * handshake fails closed with 4503 ("retry later"), never open.
 *
 * Owns: the port. Must not: answer from ticket claims.
 */
import { unavailable } from '@centcom/core';

/** What the live records say about a ticket's session, member and device. */
export interface SessionAccessResult {
  session: {
    state: 'pending' | 'live' | 'paused' | 'ended' | 'expired';
    /** `max_session_members` of the session's plan (CT-ENTITLEMENTS). */
    maxMembers: number;
  };
  /** The member as the roster has it; null when the membership was revoked or left. */
  member: { id: string; name: string; slot: number; role: 'host' | 'editor' | 'viewer' } | null;
  deviceRevoked: boolean;
  /** `relay_access` of the session's workspace. */
  relayAccess: boolean;
  /** The roster's version, for `welcome.roster_v`; 0 when the roster lane has none yet. */
  rosterV?: number;
}

/** B038's port (B043: Postgres). */
export interface SessionAccess {
  /** The live state of session `sid`, member `mid` and device `dev`; null when the session is unknown. */
  resolve(sid: string, mid: string, dev: string): Promise<SessionAccessResult | null>;
}

/** The access used until B043 lands: every lookup is a 503, so handshakes fail closed (4503). */
export const unavailableSessionAccess: SessionAccess = Object.freeze({
  resolve: () =>
    Promise.reject(
      unavailable(30, 'Sessions are not available on this relay yet.', {
        cause: new Error('no SessionAccess implementation is wired (B043)'),
      }),
    ),
});
