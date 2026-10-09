/**
 * Checking a `key.grant`'s routing data (B049, CT-WS-SESSION-EVENTS `key.grant`, hybrid): the sender
 * is a host or an editor (key holders); `p.to_device` is a `dev_` id; `p.kids` holds 1 to 200
 * entries, each `k<n>` with n from 1 and none above the session's current epoch + 1 (a grant may
 * carry the next epoch's key just before its rotation). Only `p.to_device` and `p.kids` are read;
 * `ct` and `sig` are carried, never opened. Whether the device belongs to a member is the stage's
 * (asynchronous) check.
 *
 * Owns: the rule. Must not: read `ct`.
 */
import type { SessionRole } from '../rooms/kind-policy.js';
import { epochOf } from './epochs.js';

/** Most kids one grant names. */
export const MAX_GRANT_KIDS = 200;

const DEVICE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The decision on a grant's routing data. */
export type GrantCheck =
  | { ok: true; toDevice: string }
  | { ok: false; error: 'forbidden' | 'invalid_frame'; pointer?: string };

/** The card's `validateKeyGrant`, given the sender's role and the session's current epoch. */
export function validateKeyGrant(
  frame: { p?: unknown },
  ctx: { role: SessionRole; epoch: number },
): GrantCheck {
  if (ctx.role !== 'host' && ctx.role !== 'editor') return { ok: false, error: 'forbidden' };
  const p = frame.p;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    return { ok: false, error: 'invalid_frame', pointer: '/p' };
  }
  const { to_device: toDevice, kids } = p as Record<string, unknown>;
  if (typeof toDevice !== 'string' || !DEVICE.test(toDevice)) {
    return { ok: false, error: 'invalid_frame', pointer: '/p/to_device' };
  }
  if (!Array.isArray(kids) || kids.length === 0 || kids.length > MAX_GRANT_KIDS) {
    return { ok: false, error: 'invalid_frame', pointer: '/p/kids' };
  }
  for (const [i, kid] of kids.entries()) {
    const epoch = epochOf(kid);
    if (epoch === null || epoch > ctx.epoch + 1) {
      return { ok: false, error: 'invalid_frame', pointer: `/p/kids/${i}` };
    }
  }
  return { ok: true, toDevice };
}
