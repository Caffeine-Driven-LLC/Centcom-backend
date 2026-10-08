/**
 * Webhook signatures (B081, CT-WEBHOOKS "Signing"): `t=<unix>,v1=<hex>` with v1 =
 * HMAC_SHA256(secret, t + "." + raw_body), checked here against an independent HMAC; one `v1` per
 * secret (rotation overlap), each verifying; a changed body, another secret or a `t` more than 300 s
 * away does not verify; malformed headers never do.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../../src/index.js';

const body = '{"id":"dlv_01JA3Z8K2M5N7P9Q0R1S2T3V4W","type":"webhook.test","data":{}}';
const t = 1_791_460_800;

describe('signPayload', () => {
  it('signs t.raw_body with HMAC-SHA256, one v1 per secret', () => {
    const header = signPayload(['secret-new', 'secret-old'], body, t);
    const expected = (s: string) => createHmac('sha256', s).update(`${t}.${body}`).digest('hex');
    expect(header).toBe(`t=${t},v1=${expected('secret-new')},v1=${expected('secret-old')}`);
    expect(verifySignature(header, body, 'secret-new', t)).toBe(true);
    expect(verifySignature(header, Buffer.from(body), 'secret-old', t + 300)).toBe(true);
  });

  it('does not verify a changed body, another secret, a stale t or a malformed header', () => {
    const header = signPayload(['secret'], body, t);
    expect(verifySignature(header, `${body} `, 'secret', t)).toBe(false);
    expect(verifySignature(header, body, 'other', t)).toBe(false);
    expect(verifySignature(header, body, 'secret', t + 301)).toBe(false);
    expect(verifySignature(header, body, 'secret', t - 301)).toBe(false);
    for (const bad of ['', 'v1=abc', `t=${t}`, `t=x,v1=${'0'.repeat(64)}`]) {
      expect(verifySignature(bad, body, 'secret', t)).toBe(false);
    }
    expect(() => signPayload([], body, t)).toThrow(TypeError);
    expect(() => signPayload(['s'], body, 1.5)).toThrow(TypeError);
  });
});
