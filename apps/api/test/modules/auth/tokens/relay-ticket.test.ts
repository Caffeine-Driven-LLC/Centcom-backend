/**
 * Relay tickets (B017 acceptance 8): `aud=centcom-relay`, `exp - iat = 60`, a unique `jti` across
 * 10 000 mints, the role and caps as given; checked claims; and a ticket never passes as an access
 * token (nor the other way round).
 */
import { describe, expect, it } from 'vitest';
import {
  mintRelayTicket,
  RELAY_AUDIENCE,
  RELAY_TICKET_TYPE,
  signAccessToken,
  verifyAccessJwt,
  verifyJwt,
} from '../../../../src/modules/auth/tokens/index.js';
import { memoryTokens, newId, singleKey, T0 } from './helpers.js';

const claims = () => ({
  sid: newId('ses'),
  mid: newId('mem'),
  role: 'editor' as const,
  dev: newId('dev'),
  caps: ['resume', 'compress.zstd'],
});

describe('relay tickets', () => {
  it('decode to aud centcom-relay, exp - iat = 60, the role and caps as given (acceptance 8)', async () => {
    const keys = singleKey();
    const input = claims();
    const ticket = await mintRelayTicket(keys, input, T0);
    const header = JSON.parse(
      Buffer.from(ticket.split('.')[0] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'EdDSA', kid: 'k1', typ: 'JWT' });
    const payload = await verifyJwt(keys, ticket, {
      typ: RELAY_TICKET_TYPE,
      audience: RELAY_AUDIENCE,
      nowMs: T0,
    });
    expect(payload).toMatchObject({
      ...input,
      aud: 'centcom-relay',
      iss: 'https://api.centcom.dev',
      iat: T0 / 1000,
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(60);
  });

  it('get a unique jti across 10 000 mints (acceptance 8)', async () => {
    const { tokens } = memoryTokens();
    const input = claims();
    const jtis = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const ticket = await tokens.mintRelayTicket(input);
      const payload = JSON.parse(
        Buffer.from(ticket.split('.')[1] ?? '', 'base64url').toString(),
      ) as { jti: string };
      jtis.add(payload.jti);
    }
    expect(jtis.size).toBe(10_000);
  }, 60_000);

  it('refuses claims that are not ids, roles or caps', async () => {
    const keys = singleKey();
    for (const broken of [
      { ...claims(), sid: 'session' },
      { ...claims(), mid: newId('usr') },
      { ...claims(), dev: '' },
      { ...claims(), role: 'owner' },
      { ...claims(), caps: ['ok', 'NOT OK'] },
      { ...claims(), caps: Array.from({ length: 17 }, (_, i) => `c${i}`) },
    ]) {
      await expect(
        mintRelayTicket(keys, broken as never, T0),
        JSON.stringify(broken),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('is never accepted as an access token, nor an access token as a ticket', async () => {
    const keys = singleKey();
    const ticket = await mintRelayTicket(keys, claims(), T0);
    await expect(verifyAccessJwt(keys, ticket, T0)).rejects.toMatchObject({
      code: 'token_invalid',
    });
    const { token } = await signAccessToken(
      keys,
      { sub: newId('usr'), scp: 'profile', plan: 'free', ent: 0 },
      T0,
    );
    await expect(
      verifyJwt(keys, token, { typ: RELAY_TICKET_TYPE, audience: RELAY_AUDIENCE, nowMs: T0 }),
    ).rejects.toMatchObject({
      code: 'token_invalid',
    });
  });
});
