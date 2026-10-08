/**
 * Test relay tickets (B011, CT-AUTH): the claims, the 60 s lifetime, single-use jti, the `test-`
 * key id, a JWKS with only the public key, and every way `verifyTestTicket` refuses a ticket.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeTicket,
  mintTestTicket,
  TEST_KID_PREFIX,
  testJwks,
  TICKET_AUDIENCE,
  TICKET_ISSUER,
  TICKET_TTL_S,
  verifyTestTicket,
} from '../../src/sim/index.js';
import { newId } from './helpers.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const base = { sid: newId('ses'), mid: newId('mem'), dev: newId('dev'), role: 'editor' as const };

const header = (ticket: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(ticket.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Re-signs `claims` with the given key under `kid` (for forged and foreign tickets). */
function signWith(
  claims: Record<string, unknown>,
  kid: string,
  key = generateKeyPairSync('ed25519').privateKey,
): string {
  const input = `${encode({ alg: 'EdDSA', typ: 'JWT', kid })}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

describe('mintTestTicket', () => {
  it('signs EdDSA under a test- key with aud centcom-relay, 60 s, a jti and sid/mid/role/dev/caps', async () => {
    const ticket = await mintTestTicket({ ...base, caps: ['resume'], now: NOW });
    expect(header(ticket)).toEqual({
      alg: 'EdDSA',
      typ: 'JWT',
      kid: expect.stringMatching(/^test-/) as string,
    });
    const claims = decodeTicket(ticket);
    expect(claims).toEqual({
      iss: TICKET_ISSUER,
      aud: TICKET_AUDIENCE,
      iat: NOW / 1000,
      exp: NOW / 1000 + TICKET_TTL_S,
      jti: expect.any(String) as string,
      ...base,
      caps: ['resume'],
    });
    expect(TICKET_TTL_S).toBe(60);
    expect(verifyTestTicket(ticket, { now: NOW })).toEqual({ ok: true, claims });
  });

  it('gives every ticket its own jti, and honours ttlS', async () => {
    const jtis = new Set(
      await Promise.all(
        Array.from({ length: 20 }, async () => decodeTicket(await mintTestTicket(base)).jti),
      ),
    );
    expect(jtis.size).toBe(20);
    const short = decodeTicket(await mintTestTicket({ ...base, ttlS: 5, now: NOW }));
    expect((short.exp ?? 0) - (short.iat ?? 0)).toBe(5);
  });

  it('leaves dev out for a share-link guest', async () => {
    const ticket = await mintTestTicket({ sid: base.sid, mid: base.mid, role: 'viewer' });
    expect(decodeTicket(ticket)).not.toHaveProperty('dev');
    expect(verifyTestTicket(ticket).ok).toBe(true);
  });
});

describe('testJwks', () => {
  it('publishes only the public Ed25519 key, under the test- key id the tickets use', async () => {
    const jwks = testJwks();
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(key?.kid.startsWith(TEST_KID_PREFIX)).toBe(true);
    expect(key).not.toHaveProperty('d');
    expect(header(await mintTestTicket(base))['kid']).toBe(key?.kid);
  });
});

describe('verifyTestTicket', () => {
  it('refuses an expired ticket from the second exp is reached', async () => {
    const ticket = await mintTestTicket({ ...base, now: NOW });
    expect(verifyTestTicket(ticket, { now: NOW + 59_999 }).ok).toBe(true);
    expect(verifyTestTicket(ticket, { now: NOW + 60_000 })).toEqual({
      ok: false,
      problem: 'expired',
    });
  });

  it('refuses a ticket for another audience', async () => {
    const ticket = await mintTestTicket(base);
    expect(verifyTestTicket(ticket, { audience: 'centcom-api' })).toEqual({
      ok: false,
      problem: 'wrong_audience',
    });
  });

  it('refuses a ticket signed by another key, even under the test key id', async () => {
    const ticket = await mintTestTicket(base);
    const forged = signWith(decodeTicket(ticket), String(header(ticket)['kid']));
    expect(verifyTestTicket(forged)).toEqual({ ok: false, problem: 'bad_signature' });
  });

  it('refuses a key id without the test- prefix, so a production key can never be trusted here', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const kid = 'prod-1';
    const jwks = {
      keys: [
        { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA' as const, use: 'sig' as const },
      ],
    };
    const ticket = signWith(decodeTicket(await mintTestTicket(base)), kid, privateKey);
    expect(verifyTestTicket(ticket, { jwks })).toEqual({ ok: false, problem: 'unknown_key' });
  });

  it('refuses malformed tickets and claims of the wrong shape', async () => {
    expect(verifyTestTicket('a.b')).toEqual({ ok: false, problem: 'malformed' });
    expect(verifyTestTicket('not.a.jwt')).toEqual({ ok: false, problem: 'malformed' });
    const ticket = await mintTestTicket(base);
    const kid = String(header(ticket)['kid']);
    const claims = decodeTicket(ticket);
    // Signed with the real test key by re-minting is impossible from outside, so check the shape
    // rule on a ticket whose signature is valid for its own (foreign) key set.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwks = {
      keys: [
        { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA' as const, use: 'sig' as const },
      ],
    };
    expect(verifyTestTicket(signWith(claims, kid, privateKey), { jwks }).ok).toBe(true);
    expect(
      verifyTestTicket(signWith({ ...claims, role: 'admin' }, kid, privateKey), { jwks }),
    ).toEqual({
      ok: false,
      problem: 'bad_claims',
    });
    expect(
      verifyTestTicket(signWith({ ...claims, caps: 'resume' }, kid, privateKey), { jwks }),
    ).toEqual({
      ok: false,
      problem: 'bad_claims',
    });
  });

  it('reads nothing from a ticket it cannot decode', () => {
    expect(decodeTicket('garbage')).toEqual({});
  });
});
