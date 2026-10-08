/**
 * Live checks and the welcome (B038 acceptance 2, 4 and 8, failure modes; tests
 * "handshake.access.test.ts" and the contract check): the membership/device/entitlement/session
 * matrix to close codes, the welcome built from the live membership (its role wins over the
 * ticket's), the welcome and `sys.error` frames validating against the envelope schema, frames
 * reaching the next stages only after the welcome, a first frame that is not `sys.hello` (4400),
 * malformed JSON (4400 `invalid_frame`), a hello missing its ticket (4401), and every dependency
 * failure (JWKS, Redis, SessionAccess error or 2 s timeout) closing 4503 with `retry_after_s`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from '@centcom/contracts';
import { unavailable, type KeyValue } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { SessionAccessResult } from '../../src/handshake/access.js';
import { ACCESS_TIMEOUT_MS } from '../../src/handshake/handshake.js';
import { JwksCache } from '../../src/handshake/jwks.js';
import {
  first,
  handshakeRelay,
  hello,
  mintTicket,
  send,
  stubJwks,
  ticketFor,
  TEST_HANDSHAKE_CONFIG,
  until,
} from './helpers.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../contracts/fixtures/envelope');
const fixture = (name: string): Record<string, unknown> =>
  (
    JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as {
      data: Record<string, unknown>;
    }
  ).data;

describe('the live checks', () => {
  it.each<[string, Partial<SessionAccessResult> | 'unknown', number, string]>([
    ['an unknown session', 'unknown', 4404, 'session_not_found'],
    ['an ended session', { session: { state: 'ended', maxMembers: 12 } }, 4404, 'session_ended'],
    [
      'an expired session',
      { session: { state: 'expired', maxMembers: 12 } },
      4404,
      'session_ended',
    ],
    ['a revoked membership', { member: null }, 4403, 'not_a_member'],
    ['a revoked device', { deviceRevoked: true }, 4403, 'forbidden'],
    ['no relay_access', { relayAccess: false }, 4403, 'entitlement_required'],
  ])('closes %s with %i (%s)', async (_case, record, close, code) => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor();
      if (record !== 'unknown') h.access.allow(claims, record);
      const c = h.open();
      await send(c, hello(await mintTicket(h.key, claims)));
      const error = await first(c, 'sys.error');
      expect((await c.closed).code).toBe(close);
      expect(error['p']).toMatchObject({ code });
      expect(validate('envelope', error).ok).toBe(true);
      expect(c.messages.some((m) => m['t'] === 'sys.welcome')).toBe(false);
      expect(h.passed).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  it('welcomes with the live role, not the ticket’s, and lets later frames through', async () => {
    const h = await handshakeRelay();
    try {
      const claims = ticketFor({ role: 'host' });
      h.access.allow(claims, {
        member: { id: claims.mid, name: 'Grace', slot: 2, role: 'viewer' },
        session: { state: 'paused', maxMembers: 80 },
      });
      const c = h.open();
      await send(c, hello(await mintTicket(h.key, claims)));
      const welcome = await first(c, 'sys.welcome');
      expect(validate('envelope', welcome).ok).toBe(true);
      expect(welcome['p']).toMatchObject({
        protocol: 1,
        member: { id: claims.mid, name: 'Grace', slot: 2, role: 'viewer' },
        roster_v: 3,
        heartbeat: { ping_ms: 20000, dead_ms: 50000 },
        limits: { max_frame_bytes: 262144, max_members: 50 },
        session: { state: 'paused' },
        resume: null,
      });
      expect(c.messages[0]?.['t']).toBe('sys.welcome');
      const ping = { v: 1, t: 'sys.ping', p: { t: 1 } };
      await send(c, ping);
      await until(() => h.passed.length === 1);
      expect(h.passed).toEqual([ping]);
      const authenticated = h.relay.registry.entries().find((e) => e.state === 'authenticated');
      expect(authenticated?.sessionId).toBe(claims.sid);
    } finally {
      await h.stop();
    }
  });

  it('validates the contract fixtures it builds on', () => {
    expect(validate('envelope', fixture('hello')).ok).toBe(true);
    expect(validate('envelope', fixture('welcome')).ok).toBe(true);
    expect(validate('envelope', fixture('hello_no_ticket')).ok).toBe(false);
  });
});

describe('frames the handshake refuses', () => {
  it.each([
    [
      'a first frame that is not sys.hello',
      { v: 1, t: 'sys.ping', p: {} },
      4400,
      'protocol_violation',
    ],
    ['malformed JSON', '{"v":1,"t":', 4400, 'invalid_frame'],
    ['a hello without a ticket', fixture('hello_no_ticket'), 4401, 'ticket_invalid'],
    ['the contract fixture hello (not a real ticket)', fixture('hello'), 4401, 'ticket_invalid'],
    ['a hello off the schema', { ...hello('x'.repeat(40)), v: 2 }, 4400, 'invalid_frame'],
  ])('closes %s with %i', async (_case, frame, close, code) => {
    const h = await handshakeRelay();
    try {
      const c = h.open();
      await send(c, frame);
      const error = await first(c, 'sys.error');
      expect((await c.closed).code).toBe(close);
      expect(error['p']).toMatchObject({ code });
      expect(h.passed).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  it('closes a binary first frame with 4400', async () => {
    const h = await handshakeRelay();
    try {
      const c = h.open();
      await c.opened;
      c.ws.send(Buffer.from([1, 2, 3]));
      expect((await c.closed).code).toBe(4400);
    } finally {
      await h.stop();
    }
  });
});

describe('dependencies down', () => {
  const failingKv = (): KeyValue => {
    const fail = () => Promise.reject(new Error('connect ECONNREFUSED'));
    return { get: fail, set: fail, setIfAbsent: fail, del: fail, incr: fail, ttl: fail };
  };

  it.each([
    [
      'the JWKS cannot be fetched',
      () => {
        const jwks = stubJwks([]);
        jwks.state.fail = true;
        return { jwks: new JwksCache({ url: TEST_HANDSHAKE_CONFIG.jwksUrl, fetch: jwks.fetcher }) };
      },
    ],
    ['Redis fails the jti check', () => ({ kv: failingKv() })],
    ['SessionAccess fails', () => ({ access: { resolve: () => Promise.reject(unavailable()) } })],
    [
      'SessionAccess takes longer than 2 s',
      () => ({
        access: { resolve: () => new Promise<never>(() => undefined) },
        setTimer: (fn: () => void, ms: number) => {
          const handle = setTimeout(fn, ms === ACCESS_TIMEOUT_MS ? 20 : ms);
          return { cancel: () => clearTimeout(handle) };
        },
      }),
    ],
  ])('closes 4503 with retry_after_s when %s', async (_case, overrides) => {
    const h = await handshakeRelay(overrides() as never);
    try {
      const claims = ticketFor();
      h.access.allow(claims);
      const c = h.open();
      await send(c, hello(await mintTicket(h.key, claims)));
      const error = await first(c, 'sys.error');
      expect((await c.closed).code).toBe(4503);
      expect(error['p']).toMatchObject({ status: 503, retry_after_s: expect.any(Number) });
      expect(JSON.stringify(error)).not.toContain('ECONNREFUSED');
    } finally {
      await h.stop();
    }
  });
});
