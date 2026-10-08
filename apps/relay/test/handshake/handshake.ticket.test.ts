/**
 * Relay tickets (B038 acceptance 2, 3 and 9; tests "handshake.ticket.test.ts"): a ticket minted as
 * the API mints it verifies; a bad signature, another audience, issuer or `typ`, an `exp` beyond
 * the 60 s skew, an `iat` in the future, `alg: none`, an HS256 downgrade keyed with the public key,
 * an embedded `jwk`/`jku`, an unknown `kid` and bad claims are all the same TicketError; JWKS
 * unavailable is a 503. Over a connection: one uniform 4401 body for every bad ticket, and a
 * replayed ticket is 4401 even after the first connection closed. Verification takes under 5 ms
 * p95 with a warm cache (measured in a child process).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { JwksCache } from '../../src/handshake/jwks.js';
import { TicketError, verifyRelayTicket } from '../../src/handshake/ticket.js';
import {
  first,
  handshakeRelay,
  hello,
  mintTicket,
  send,
  signingKey,
  stubJwks,
  ticketFor,
  until,
} from './helpers.js';

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const b64 = (value: object | string): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function setup() {
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const cache = new JwksCache({
    url: 'https://api.centcom.test/jwks',
    fetch: jwks.fetcher,
    clock: () => NOW,
  });
  const verify = (token: unknown, nowMs = NOW) => verifyRelayTicket(token, { jwks: cache, nowMs });
  return { key, jwks, cache, verify };
}

const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'valid',
    (err: unknown) =>
      err instanceof TicketError ? 'invalid' : isAppError(err) ? `${err.status}` : String(err),
  );

describe('verifyRelayTicket', () => {
  it('accepts a ticket minted as the API mints it, returning its claims', async () => {
    const { key, verify } = setup();
    const claims = ticketFor({ role: 'host', caps: ['resume', 'cursor.coalesce'] });
    const ticket = await mintTicket(key, claims, { nowMs: NOW, jti: 'jti-1' });
    expect(await verify(ticket)).toEqual({
      ...claims,
      jti: 'jti-1',
      exp: Math.floor(NOW / 1000) + 60,
    });
  });

  it('honours 60 s of skew on exp and iat, and no more', async () => {
    const { key, verify } = setup();
    const ticket = await mintTicket(key, ticketFor(), { nowMs: NOW });
    expect(await outcome(verify(ticket, NOW + 119_000))).toBe('valid');
    expect(await outcome(verify(ticket, NOW + 121_000))).toBe('invalid');
    const early = await mintTicket(key, ticketFor(), { nowMs: NOW, iatOffsetS: 59 });
    expect(await outcome(verify(early))).toBe('valid');
    const future = await mintTicket(key, ticketFor(), { nowMs: NOW, iatOffsetS: 120 });
    expect(await outcome(verify(future))).toBe('invalid');
  });

  it.each([
    ['another audience', { audience: 'centcom-api' }],
    ['another issuer', { issuer: 'https://evil.test' }],
    ['another typ', { typ: 'at+jwt' }],
    ['an unknown kid', { header: { kid: 'k9' } }],
    ['a bad sid', { extra: { sid: 'ses_nope' } }],
    ['a bad role', { extra: { role: 'owner' } }],
    ['bad caps', { extra: { caps: ['Resume!'] } }],
    ['too many caps', { extra: { caps: Array.from({ length: 17 }, (_, i) => `c${i}`) } }],
  ])('refuses %s', async (_case, opts) => {
    const { key, verify } = setup();
    expect(await outcome(verify(await mintTicket(key, ticketFor(), { nowMs: NOW, ...opts })))).toBe(
      'invalid',
    );
  });

  it('refuses a ticket signed by another key under a known kid', async () => {
    const { verify } = setup();
    const forger = signingKey('k1');
    expect(await outcome(verify(await mintTicket(forger, ticketFor(), { nowMs: NOW })))).toBe(
      'invalid',
    );
  });

  it('refuses alg none and an HS256 downgrade keyed with the public key', async () => {
    const { key, verify } = setup();
    const exp = Math.floor(NOW / 1000) + 60;
    const payload = b64({
      ...ticketFor(),
      iss: 'https://api.centcom.dev',
      aud: 'centcom-relay',
      iat: exp - 60,
      exp,
      jti: 'x',
    });
    const none = `${b64({ alg: 'none', kid: 'k1', typ: 'JWT' })}.${payload}.`;
    expect(await outcome(verify(none))).toBe('invalid');
    const header = b64({ alg: 'HS256', kid: 'k1', typ: 'JWT' });
    const secret = String((key.jwk as { x: string }).x);
    const mac = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    expect(await outcome(verify(`${header}.${payload}.${mac}`))).toBe('invalid');
  });

  it('never uses a key the ticket carries (jwk or jku headers)', async () => {
    const { verify } = setup();
    const attacker = signingKey('k1');
    const ticket = await mintTicket(attacker, ticketFor(), {
      nowMs: NOW,
      header: { jwk: attacker.jwk as never, jku: 'https://evil.test/jwks' },
    });
    expect(await outcome(verify(ticket))).toBe('invalid');
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['garbage', 'not.a.jwt'],
    ['too long', 'a'.repeat(5000)],
  ])('refuses a token that is %s', async (_case, token) => {
    const { verify } = setup();
    expect(await outcome(verify(token))).toBe('invalid');
  });

  it('answers 503 when no keys can be had', async () => {
    const { key, jwks, verify } = setup();
    jwks.state.fail = true;
    expect(await outcome(verify(await mintTicket(key, ticketFor(), { nowMs: NOW })))).toBe('503');
  });

  it('verifies in under 5 ms p95 with a warm cache (child process)', () => {
    const bench = resolve(import.meta.dirname, 'ticket-bench.ts');
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');
    const tsconfig = resolve(import.meta.dirname, '../../../../tsconfig.test.json');
    const out = execFileSync(process.execPath, [tsx, '--tsconfig', tsconfig, bench], {
      input: JSON.stringify({ runs: 200 }),
      encoding: 'utf8',
    });
    const { p95, fetches } = JSON.parse(out) as { p95: number; fetches: number };
    expect(fetches).toBe(1);
    expect(p95).toBeLessThan(5);
  }, 60_000);
});

describe('tickets over a connection', () => {
  it('answers every bad ticket with the same 4401 body', async () => {
    const h = await handshakeRelay();
    try {
      const forger = signingKey('k1');
      const bodies: unknown[] = [];
      for (const ticket of [
        await mintTicket(forger, ticketFor()),
        await mintTicket(h.key, ticketFor(), { audience: 'centcom-api' }),
        await mintTicket(h.key, ticketFor(), { nowMs: Date.now() - 200_000 }),
        await mintTicket(h.key, ticketFor(), { header: { kid: 'k7' } }),
        'short',
      ]) {
        const client = h.open();
        await send(client, hello(ticket));
        const error = await first(client, 'sys.error');
        expect((await client.closed).code).toBe(4401);
        const body = { ...(error['p'] as Record<string, unknown>) };
        delete body['request_id'];
        bodies.push(body);
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0]).toMatchObject({ code: 'ticket_invalid', status: 401 });
      expect(h.relay.log.raw()).not.toContain('eyJ');
    } finally {
      await h.stop();
    }
  });

  it('refuses a ticket used before, even after its first connection closed', async () => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor();
      h.access.allow(claims);
      const ticket = await mintTicket(h.key, claims);
      const firstUse = h.open();
      await send(firstUse, hello(ticket));
      await first(firstUse, 'sys.welcome');
      firstUse.ws.close();
      await firstUse.closed;
      const replay = h.open();
      await send(replay, hello(ticket));
      const error = await first(replay, 'sys.error');
      expect((await replay.closed).code).toBe(4401);
      expect(error['p']).toMatchObject({ code: 'ticket_replayed' });
    } finally {
      await h.stop();
    }
  });

  it('lets only one of two concurrent hellos with one ticket through', async () => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor();
      h.access.allow(claims);
      const ticket = await mintTicket(h.key, claims);
      const clients = [h.open(), h.open()];
      await Promise.all(clients.map((c) => send(c, hello(ticket))));
      const answered = (c: (typeof clients)[number]): boolean =>
        c.messages.some((m) => m['t'] === 'sys.welcome' || m['t'] === 'sys.error');
      await until(() => clients.every(answered), 3_000);
      const kinds = clients.map((c) => c.messages[0]?.['t']).sort();
      expect(kinds).toEqual(['sys.error', 'sys.welcome']);
      const refused = clients.find((c) => c.messages[0]?.['t'] === 'sys.error');
      expect(refused?.messages[0]?.['p']).toMatchObject({ code: 'ticket_replayed' });
    } finally {
      await h.stop();
    }
  });
});
