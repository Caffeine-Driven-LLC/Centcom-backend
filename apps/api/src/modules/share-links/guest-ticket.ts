/**
 * Share-link tokens and guest tickets (B068, CT-API-SESSIONS, CT-RBAC "Share-link guests").
 *
 * - **Tokens:** 32 random bytes, base64url, so 43 characters and 256 bits (the contract asks for
 *   at least 160). Only `hashShareToken(token)` (SHA-256) is stored, and lookups go by that hash.
 *   A stored hash is compared to the computed one with `timingSafeEqual`. A token is never
 *   logged and is returned once, at creation.
 * - **Tickets:** B017's `mintGuestRelayTicket`: `role` `viewer`, no `dev`, no `caps`, `aud`
 *   `centcom-relay`, 60 s, a fresh `jti`. The `jti` is recorded for 60 s under B054's
 *   `ticket:issued:` prefix before the ticket is returned (no record, no ticket).
 *
 * Owns: the token's form and the guest ticket. Must not: put a token or a ticket in a log or a
 * URL the server builds for anything but the link itself.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyValue } from '@centcom/core';
import type { GuestTicketClaims } from '../auth/tokens/relay-ticket.js';

/** Random bytes in a token (256 bits; base64url: 43 characters). */
export const SHARE_TOKEN_BYTES = 32;
/** Where a link points (CT-DEEPLINK `/j/<token>`; the client adds the `#k=` fragment). */
export const SHARE_LINK_URL_BASE = 'https://centcom.dev/j/';
/** B054's record of issued tickets (`{prefix}{jti}`, 60 s). */
export const GUEST_TICKET_RECORD_PREFIX = 'ticket:issued:';
/** A ticket's life, in seconds (B017). */
export const GUEST_TICKET_TTL_S = 60;

/** What the path may hold (the contract's 16 to 128 URL-safe characters). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/** A new token. */
export const newShareToken = (): string => randomBytes(SHARE_TOKEN_BYTES).toString('base64url');

/** The SHA-256 of `token` (what is stored). */
export const hashShareToken = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

/** True when `token` has a token's shape (anything else is not looked up). */
export const isShareTokenShape = (token: unknown): token is string =>
  typeof token === 'string' && TOKEN_SHAPE.test(token);

/** Constant-time equality of two hashes. */
export function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What issuing a guest ticket needs. */
export interface GuestTicketDeps {
  /** B017's TokenService. */
  tickets: { mintGuestRelayTicket(claims: GuestTicketClaims): Promise<string> };
  /** Where issued tickets' `jti`s are recorded (B054's `issued`). */
  issued: Pick<KeyValue, 'set'>;
}

/** Why a ticket could not be issued. */
export class GuestTicketError extends Error {
  override name = 'GuestTicketError';
  constructor(readonly reason: 'signing' | 'record') {
    super(`guest ticket: ${reason} failed`);
  }
}

/** A signed, recorded guest ticket for member `mid` of session `sid`. */
export async function issueGuestTicket(
  deps: GuestTicketDeps,
  sid: string,
  mid: string,
): Promise<string> {
  let ticket: string;
  try {
    ticket = await deps.tickets.mintGuestRelayTicket({ sid, mid });
  } catch {
    throw new GuestTicketError('signing');
  }
  const jti = jtiOf(ticket);
  try {
    if (jti === null) throw new Error('no jti');
    await deps.issued.set(`${GUEST_TICKET_RECORD_PREFIX}${jti}`, `${sid}:${mid}`, {
      ttlMs: GUEST_TICKET_TTL_S * 1000,
    });
  } catch {
    throw new GuestTicketError('record');
  }
  return ticket;
}

/** The `jti` of a JWT the API just signed; null when it has none. */
function jtiOf(jwt: string): string | null {
  const payload = jwt.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    const jti = (claims as Record<string, unknown> | null)?.['jti'];
    return typeof jti === 'string' && jti !== '' ? jti : null;
  } catch {
    return null;
  }
}
