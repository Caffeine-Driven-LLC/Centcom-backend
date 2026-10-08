/**
 * Webhook signatures (B081, CT-WEBHOOKS "Signing"): `Centcom-Signature: t=<unix>,v1=<hex>`, where
 * `v1 = HMAC_SHA256(secret, t + "." + raw_body)` over the exact bytes sent. During a secret's 24 h
 * rotation overlap the header carries one `v1` per secret (new first), and either verifies.
 * Receivers reject a `t` more than 300 s from their clock.
 *
 * Owns: the header format. Must not: log a secret or a signature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far `t` may be from the receiver's clock. */
export const WEBHOOK_SIGNATURE_TOLERANCE_S = 300;

/** The hex HMAC-SHA256 of `t.rawBody` under `secret`. */
function v1(secret: string, rawBody: string | Buffer, t: number): string {
  return createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
}

/** The `Centcom-Signature` value of `rawBody` at `nowSeconds`, one `v1` per secret, in order. */
export function signPayload(
  secrets: readonly string[],
  rawBody: string,
  nowSeconds: number,
): string {
  if (secrets.length === 0) throw new TypeError('signPayload: at least one secret is needed');
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError('signPayload: nowSeconds must be whole Unix seconds');
  }
  return [`t=${nowSeconds}`, ...secrets.map((s) => `v1=${v1(s, rawBody, nowSeconds)}`)].join(',');
}

/**
 * Whether `header` holds a `v1` of `rawBody` under `secret`, with `t` within `toleranceS` of
 * `nowSeconds` (what a receiver does).
 */
export function verifySignature(
  header: string,
  rawBody: string | Buffer,
  secret: string,
  nowSeconds: number,
  toleranceS = WEBHOOK_SIGNATURE_TOLERANCE_S,
): boolean {
  let t: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined && /^\d{1,12}$/.test(value)) t = Number(value);
    else if (key === 'v1' && value !== undefined && /^[0-9a-f]{64}$/.test(value))
      candidates.push(value);
  }
  if (t === null || Math.abs(nowSeconds - t) > toleranceS) return false;
  const expected = Buffer.from(v1(secret, rawBody, t), 'hex');
  return candidates.some((hex) => timingSafeEqual(Buffer.from(hex, 'hex'), expected));
}
