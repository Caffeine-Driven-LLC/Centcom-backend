/**
 * Relay ticket verification (B038, CT-AUTH "Relay ticket"): the JWT a client presents in
 * `sys.hello`, minted by the API (B017). Accepted only when it is EdDSA (no other algorithm, never
 * `none`), signed by a key of the API's JWKS (by `kid`; the ticket's own `jwk`/`jku` headers are
 * never used), issued by the API for audience `centcom-relay` with `typ` JWT, within its `exp`
 * (60 s of clock skew either way, `iat` not in the future), and carries well-formed `sid`, `mid`,
 * `role`, `dev`, `caps` and `jti`.
 *
 * Every refusal is the same TicketError, whatever the cause (bad signature, unknown `kid`,
 * expired, wrong audience), so callers cannot become an oracle. Keys that cannot be had at all
 * (JWKS unreachable for over an hour) are a 503 instead.
 *
 * Owns: the checks. Must not: log or return the ticket, or decide on a claim's authority (the live
 * membership does: CT-RBAC rule 3).
 */
import { isId } from '@centcom/contracts';
import { isAppError } from '@centcom/core';
import { jwtVerify, type JWTHeaderParameters } from 'jose';
import type { JwksCache } from './jwks.js';

/** Audience of relay tickets (B017 `RELAY_AUDIENCE`). */
export const RELAY_AUDIENCE = 'centcom-relay';
/** Issuer of every API token (B017 `TOKEN_ISSUER`). */
export const TICKET_ISSUER = 'https://api.centcom.dev';
/** `typ` of relay tickets (B017 `RELAY_TICKET_TYPE`). */
export const TICKET_TYPE = 'JWT';
/** Clock skew tolerated on `exp`, `nbf` and `iat`, in seconds (CT-AUTH). */
export const TICKET_CLOCK_SKEW_S = 60;
/** The longest ticket looked at. */
export const MAX_TICKET_LENGTH = 4096;

const ROLES: ReadonlySet<string> = new Set(['host', 'editor', 'viewer']);
const CAP = /^[a-z0-9._-]{1,32}$/;

/** What a verified ticket says. */
export interface TicketClaims {
  sid: string;
  mid: string;
  /** A hint only: the live membership's role wins. */
  role: 'host' | 'editor' | 'viewer';
  dev: string;
  caps: string[];
  jti: string;
  /** Seconds since the epoch. */
  exp: number;
}

/** What verification needs. */
export interface TicketDeps {
  jwks: Pick<JwksCache, 'key'>;
  /** Milliseconds since the epoch. */
  nowMs: number;
}

/** A ticket that is not valid; deliberately says nothing about why. */
export class TicketError extends Error {
  override name = 'TicketError';
  constructor() {
    super('The relay ticket is not valid.');
  }
}

/** The claims of a valid ticket; rejects with TicketError, or a 503 AppError when no keys can be had. */
export async function verifyRelayTicket(token: unknown, deps: TicketDeps): Promise<TicketClaims> {
  if (typeof token !== 'string' || token === '' || token.length > MAX_TICKET_LENGTH) {
    throw new TicketError();
  }
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(
      token,
      (header: JWTHeaderParameters) => {
        if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') throw new TicketError();
        return deps.jwks.key(header.kid);
      },
      {
        algorithms: ['EdDSA'],
        audience: RELAY_AUDIENCE,
        issuer: TICKET_ISSUER,
        typ: TICKET_TYPE,
        clockTolerance: TICKET_CLOCK_SKEW_S,
        currentDate: new Date(deps.nowMs),
        requiredClaims: ['exp', 'iat', 'jti'],
      },
    );
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    if (isAppError(err) && err.status === 503) throw err;
    throw new TicketError();
  }
  const { sid, mid, role, dev, caps, jti, exp, iat } = payload;
  if (
    !isId('ses', sid) ||
    !isId('mem', mid) ||
    !isId('dev', dev) ||
    typeof role !== 'string' ||
    !ROLES.has(role) ||
    !Array.isArray(caps) ||
    caps.length > 16 ||
    !caps.every((cap) => typeof cap === 'string' && CAP.test(cap)) ||
    typeof jti !== 'string' ||
    jti === '' ||
    jti.length > 128 ||
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    iat > Math.floor(deps.nowMs / 1000) + TICKET_CLOCK_SKEW_S
  ) {
    throw new TicketError();
  }
  return {
    sid,
    mid,
    role: role as TicketClaims['role'],
    dev,
    caps: caps as string[],
    jti,
    exp,
  };
}
