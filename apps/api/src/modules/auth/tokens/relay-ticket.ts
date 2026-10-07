/**
 * Relay tickets (B017, CT-AUTH): the short JWT a client presents in `sys.hello` to join a session
 * on the relay: `aud` `centcom-relay`, 60 s, a unique `jti` (the relay keeps it to refuse a second
 * use), and claims `sid`, `mid`, `role`, `dev`, `caps`. Signed with the API's active key, so the
 * relay verifies it against the same JWKS. The sessions lane's join-token endpoint calls this.
 *
 * Owns: minting. Single-use enforcement is the relay's (B038).
 */
import { isId } from '@centcom/contracts';
import { AppError } from '@centcom/core';
import type { TokenKeys } from './config.js';
import { signJwt } from './jwt.js';

/** Audience of relay tickets. */
export const RELAY_AUDIENCE = 'centcom-relay';
/** Relay ticket lifetime: 60 s. */
export const RELAY_TICKET_TTL_S = 60;
/** `typ` of relay tickets (plain JWT: no access token passes as one, nor one as an access token). */
export const RELAY_TICKET_TYPE = 'JWT';

/** Session roles (CT-RBAC). */
export type SessionRole = 'host' | 'editor' | 'viewer';

/** What a ticket says. */
export interface RelayTicketClaims {
  /** Session (`ses_…`). */
  sid: string;
  /** Session member (`mem_…`). */
  mid: string;
  role: SessionRole;
  /** Device (`dev_…`). */
  dev: string;
  caps: string[];
}

const ROLES: ReadonlySet<string> = new Set<SessionRole>(['host', 'editor', 'viewer']);
const CAP = /^[a-z0-9._-]{1,32}$/;

/** A signed relay ticket for `claims`, valid 60 s from `nowMs`. */
export async function mintRelayTicket(
  keys: TokenKeys,
  claims: RelayTicketClaims,
  nowMs: number,
): Promise<string> {
  const { sid, mid, role, dev, caps } = claims;
  if (
    !isId('ses', sid) ||
    !isId('mem', mid) ||
    !isId('dev', dev) ||
    !ROLES.has(role) ||
    !Array.isArray(caps) ||
    caps.length > 16 ||
    !caps.every((cap) => typeof cap === 'string' && CAP.test(cap))
  ) {
    throw new AppError('invalid_request', { detail: 'The relay ticket claims are not valid.' });
  }
  return signJwt(
    keys,
    { sid, mid, role, dev, caps: [...caps] },
    { typ: RELAY_TICKET_TYPE, audience: RELAY_AUDIENCE, ttlS: RELAY_TICKET_TTL_S, nowMs },
  );
}
