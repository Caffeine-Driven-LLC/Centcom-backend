/**
 * Coupon codes (B079): how a code a user typed becomes the one Stripe is asked about, and the
 * only form of it Centcom keeps.
 *
 * - `normaliseCode`: NFC, trimmed, upper case (Stripe's promotion codes are case-insensitive);
 *   null for anything that cannot be a code (empty, over 64 characters, whitespace or control
 *   characters inside).
 * - `codeHash`: the sha256 (hex) of the normalised code. The ledger, the logs and the audit never
 *   hold the code itself.
 *
 * Owns: normalising and hashing. Must not: keep, log or return a code.
 */
import { createHash } from 'node:crypto';
import { hasControlChars } from '@centcom/contracts';

/** The longest code (CT-API-BILLING `CouponRedeem.code`). */
export const MAX_CODE_LENGTH = 64;

/** The code as Stripe is asked about it, or null when `raw` cannot be one. */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_CODE_LENGTH * 4) return null;
  const code = raw.normalize('NFC').trim().toUpperCase();
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) return null;
  if (hasControlChars(code) || /\s/u.test(code)) return null;
  return code;
}

/** The sha256 (hex) of a normalised code: what the ledger keeps. */
export const codeHash = (normalised: string): string =>
  createHash('sha256').update(normalised, 'utf8').digest('hex');
