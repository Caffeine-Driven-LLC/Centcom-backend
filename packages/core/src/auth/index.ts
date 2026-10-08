/**
 * Revocation announcements (B087): when staff revoke a user's tokens or one of their devices, the
 * API publishes an `AuthRevocationEvent` on `centcom:auth-revocations` after the revocation is
 * stored, so the relay can close that user's (or device's) sockets with 4401 at once
 * (CT-WS-ENVELOPE) instead of when they next reconnect. A lost message is covered by the relay's
 * own checks; revocation itself never depends on it.
 *
 * Owns: the channel name and the event shapes. Must not: carry anything but ids and a time.
 */
import { isId } from '@centcom/contracts';
import type { PubSub } from '../redis/types.js';

/** Redis pub/sub channel of revocations. */
export const AUTH_REVOCATIONS_CHANNEL = 'centcom:auth-revocations';

/** Every access and refresh token of `user` issued until `at` (RFC 3339) was revoked. */
export interface UserTokensRevokedEvent {
  type: 'user.tokens_revoked';
  user: string;
  at: string;
}

/** Device `dev` of `user` was revoked at `at` (RFC 3339). */
export interface DeviceRevokedEvent {
  type: 'device.revoked';
  user: string;
  dev: string;
  at: string;
}

/** A revocation announcement. */
export type AuthRevocationEvent = UserTokensRevokedEvent | DeviceRevokedEvent;

/** Publishes `event`; rejects when Redis does. */
export function publishAuthRevocation(
  pubsub: Pick<PubSub, 'publish'>,
  event: AuthRevocationEvent,
): Promise<void> {
  return pubsub.publish(AUTH_REVOCATIONS_CHANNEL, JSON.stringify(event));
}

/** The event in `message`, or null for anything that is not a well-formed one. */
export function parseAuthRevocation(message: string): AuthRevocationEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (!isId('usr', e['user']) || typeof e['at'] !== 'string' || Number.isNaN(Date.parse(e['at']))) {
    return null;
  }
  if (e['type'] === 'user.tokens_revoked') {
    return { type: 'user.tokens_revoked', user: e['user'], at: e['at'] };
  }
  if (e['type'] === 'device.revoked' && isId('dev', e['dev'])) {
    return { type: 'device.revoked', user: e['user'], dev: e['dev'], at: e['at'] };
  }
  return null;
}
