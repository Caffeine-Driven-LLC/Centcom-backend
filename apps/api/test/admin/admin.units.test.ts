/**
 * The admin API's parts (B087), without HTTP: the CIDR allowlist, e-mail masking, the response
 * scrub, reason and ticket checks, role order, the staff cache (at most 5 s), call outcomes and
 * events, revocation announcements, B017's user revocation flag and the staff refresh decision.
 */
import { newId } from '@centcom/contracts';
import {
  AUTH_REVOCATIONS_CHANNEL,
  createMemoryRedis,
  parseAuthRevocation,
  publishAuthRevocation,
  toAuditRow,
} from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_AUDIT_ACTIONS,
  callEvent,
  cidrMatcher,
  maskEmail,
  newCall,
  outcomeOf,
  parseCidr,
  roleAtLeast,
  scrub,
  STAFF_ROLES,
  StaffDirectory,
  validReason,
  validTicket,
  type Cidr,
} from '../../src/modules/admin/index.js';
import { decideRotation, RevocationList } from '../../src/modules/auth/tokens/index.js';

const cidrs = (...texts: string[]): Cidr[] =>
  texts.map((t) => {
    const c = parseCidr(t);
    if (c === null) throw new Error(t);
    return c;
  });

describe('CIDR allowlist', () => {
  it('parses IPv4 and IPv6 blocks and bare addresses, and nothing else', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ address: '10.0.0.0', prefix: 8, family: 'ipv4' });
    expect(parseCidr(' fd00::/8 ')).toEqual({ address: 'fd00::', prefix: 8, family: 'ipv6' });
    expect(parseCidr('192.168.1.7')).toEqual({
      address: '192.168.1.7',
      prefix: 32,
      family: 'ipv4',
    });
    expect(parseCidr('::1')).toEqual({ address: '::1', prefix: 128, family: 'ipv6' });
    for (const bad of [
      '10.0.0.0/33',
      '::/129',
      '10.0.0/8',
      'example.com',
      '10.0.0.0/8/1',
      '10.0.0.0/-1',
      '',
    ]) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });

  it('matches addresses inside the blocks, IPv4 seen through IPv6 included', () => {
    const allowed = cidrMatcher(cidrs('10.0.0.0/8', '192.168.4.0/24', 'fd00::/8'));
    expect(allowed('10.200.3.4')).toBe(true);
    expect(allowed('::ffff:10.1.2.3')).toBe(true);
    expect(allowed('192.168.4.255')).toBe(true);
    expect(allowed('fd12:3456::1')).toBe(true);
    expect(allowed('192.168.5.1')).toBe(false);
    expect(allowed('127.0.0.1')).toBe(false);
    expect(allowed('::ffff:127.0.0.1')).toBe(false);
    expect(allowed('fe80::1')).toBe(false);
    expect(allowed(undefined)).toBe(false);
    expect(allowed('not-an-address')).toBe(false);
    expect(cidrMatcher([])('10.0.0.1')).toBe(false);
  });
});

describe('redaction', () => {
  it('masks e-mail addresses as a***@d***.com', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@e***.com');
    expect(maskEmail('b@mail.example.co.uk')).toBe('b***@m***.uk');
    expect(maskEmail('root@localhost')).toBe('r***@l***');
    expect(maskEmail('élodie@exemple.fr')).toBe('é***@e***.fr');
    expect(maskEmail('not-an-address')).toBe('***');
  });

  it('drops content, key and credential fields and rewrites credential values', () => {
    const subId = newId('sub');
    const out = scrub({
      id: newId('usr'),
      ct: 'ciphertext',
      p: 'payload',
      key_bundle: 'AAAA',
      webhook_secret: 'whsec_x',
      refresh_token: 'abc',
      access_token: 'abc',
      x25519_pub: 'key',
      fingerprint: 'ABCD-EFGH-JKLM',
      nested: [{ password: 'pw', name: `cen_live_${'a'.repeat(32)}`, ok: 'fine' }],
      jwt: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c3IifQ.c2ln',
      stripe: 'cus_N9rQ2bXk4LmPz8Tw',
      ours: subId,
      at: new Date(Date.UTC(2026, 9, 8)),
      count: 3,
      none: null,
    });
    expect(out).toEqual({
      id: expect.any(String) as unknown,
      nested: [{ name: '[redacted]', ok: 'fine' }],
      jwt: '[redacted]',
      stripe: 'cus_****z8Tw',
      ours: subId,
      at: '2026-10-08T00:00:00.000Z',
      count: 3,
      none: null,
    });
  });
});

describe('reason and ticket', () => {
  it('takes a reason of 10 to 500 characters without control characters', () => {
    expect(validReason(undefined)).toBeNull();
    expect(validReason('123456789')).toBeNull();
    expect(validReason('1234567890')).toBe('1234567890');
    expect(validReason('  padded reason here  ')).toBe('padded reason here');
    expect(validReason('x'.repeat(500))).toHaveLength(500);
    expect(validReason('x'.repeat(501))).toBeNull();
    expect(validReason('😀'.repeat(10))).toBe('😀'.repeat(10));
    expect(validReason('a reason\u0000with a null')).toBeNull();
    expect(validReason(['one reason here', 'another reason'])).toBeNull();
  });

  it('takes an optional ticket of 1 to 64 safe characters', () => {
    expect(validTicket(undefined)).toBeNull();
    expect(validTicket('SUP-1234')).toBe('SUP-1234');
    expect(validTicket('jira:OPS/42#c3')).toBe('jira:OPS/42#c3');
    expect(validTicket('x'.repeat(64))).toHaveLength(64);
    expect(validTicket('x'.repeat(65))).toBeUndefined();
    expect(validTicket('two words')).toBeUndefined();
    expect(validTicket('')).toBeUndefined();
    expect(validTicket(['A-1', 'B-2'])).toBeUndefined();
  });
});

describe('roles and the staff cache', () => {
  it('orders roles support_ro < support_rw < superadmin', () => {
    expect(STAFF_ROLES).toEqual(['support_ro', 'support_rw', 'superadmin']);
    expect(roleAtLeast('support_ro', 'support_ro')).toBe(true);
    expect(roleAtLeast('support_ro', 'support_rw')).toBe(false);
    expect(roleAtLeast('support_rw', 'support_ro')).toBe(true);
    expect(roleAtLeast('support_rw', 'superadmin')).toBe(false);
    expect(roleAtLeast('superadmin', 'support_rw')).toBe(true);
  });

  it('reads a staff row at most 5 s ago, whatever the ttl asked for, and drops disabled rows', async () => {
    let now = 0;
    let reads = 0;
    let row: { role: 'support_rw'; disabled_at: Date | null } | null = {
      role: 'support_rw',
      disabled_at: null,
    };
    const reader = {
      staff: () => {
        reads += 1;
        return Promise.resolve(
          row === null ? null : { user_id: 'u', added_by: null, added_at: new Date(0), ...row },
        );
      },
    };
    const directory = new StaffDirectory({ reader, clock: () => now, ttlMs: 60_000 });
    const userId = newId('usr');
    expect(await directory.role(userId)).toBe('support_rw');
    now = 4_999;
    expect(await directory.role(userId)).toBe('support_rw');
    expect(reads).toBe(1);
    row = { role: 'support_rw', disabled_at: new Date(1) };
    now = 5_000;
    expect(await directory.role(userId)).toBeNull();
    expect(reads).toBe(2);
    row = null;
    directory.forget(userId);
    expect(await directory.role(userId)).toBeNull();
    expect(reads).toBe(3);

    const failing = new StaffDirectory({
      reader: { staff: () => Promise.reject(new Error('down')) },
    });
    await expect(failing.role(userId)).rejects.toThrow('down');
  });
});

describe('call events', () => {
  it('calls 401, 403 and 429 refusals, earlier problems denied, later ones failed', () => {
    const call = newCall(newId('req'), 'GET', '/internal/admin/v1/users/:id');
    expect(outcomeOf(call, 200)).toBe('success');
    expect(outcomeOf(call, 400)).toBe('denied');
    expect(outcomeOf(call, 404)).toBe('denied');
    call.phase = 'work';
    for (const status of [401, 403, 429]) expect(outcomeOf(call, status)).toBe('denied');
    for (const status of [400, 404, 409, 422, 502, 503])
      expect(outcomeOf(call, status)).toBe('failed');
  });

  it('builds events the emitter accepts, with nothing but the allowlisted meta', () => {
    const call = newCall(newId('req'), 'PUT', '/internal/admin/v1/flags/:key');
    call.actor = { type: 'staff', id: newId('usr') };
    call.staff = { userId: call.actor.id, role: 'support_rw' };
    call.flag = 'beta.banner';
    call.reason = 'Customer asked for the beta banner';
    const row = toAuditRow(
      callEvent(call, 'success', 200, null),
      ADMIN_AUDIT_ACTIONS,
      newId('aud'),
      new Date(0),
    );
    expect(row).toMatchObject({
      workspace_id: null,
      actor_type: 'staff',
      action: 'staff.access',
      target_type: null,
      outcome: 'success',
      request_id: call.requestId,
    });
    expect(JSON.parse(row.meta) as unknown).toEqual({
      method: 'PUT',
      route: '/internal/admin/v1/flags/:key',
      status: 200,
      code: null,
      role: 'support_rw',
      flag: 'beta.banner',
    });
    // The reason is free text: it never goes into meta.
    expect(row.meta).not.toContain('beta banner');
  });
});

describe('revocation', () => {
  it('announces revocations on centcom:auth-revocations, and reads them back strictly', async () => {
    const redis = createMemoryRedis();
    const seen: string[] = [];
    await redis.pubsub.subscribe(AUTH_REVOCATIONS_CHANNEL, (m) => seen.push(m));
    const user = newId('usr');
    const dev = newId('dev');
    await publishAuthRevocation(redis.pubsub, {
      type: 'device.revoked',
      user,
      dev,
      at: '2026-10-08T12:00:00.000Z',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen.map(parseAuthRevocation)).toEqual([
      { type: 'device.revoked', user, dev, at: '2026-10-08T12:00:00.000Z' },
    ]);
    expect(
      parseAuthRevocation(
        JSON.stringify({ type: 'user.tokens_revoked', user, at: '2026-10-08T12:00:00Z', extra: 1 }),
      ),
    ).toEqual({
      type: 'user.tokens_revoked',
      user,
      at: '2026-10-08T12:00:00Z',
    });
    for (const bad of [
      'not json',
      'null',
      JSON.stringify({ type: 'user.tokens_revoked', user: 'usr_x', at: '2026-10-08T12:00:00Z' }),
      JSON.stringify({ type: 'device.revoked', user, at: '2026-10-08T12:00:00Z' }),
      JSON.stringify({ type: 'user.deleted', user, at: '2026-10-08T12:00:00Z' }),
      JSON.stringify({ type: 'user.tokens_revoked', user, at: 'yesterday' }),
    ]) {
      expect(parseAuthRevocation(bad), bad).toBeNull();
    }
  });

  it('revokes every access token of a user issued until the revocation (B017 flag)', async () => {
    let now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const redis = createMemoryRedis(() => now);
    const list = new RevocationList({ kv: redis.kv, now: () => now });
    const sub = newId('usr');
    const claims = (iatMs: number) => ({
      jti: newId('req'),
      scp: 'profile',
      sub,
      iat: Math.floor(iatMs / 1000),
    });
    const before = claims(now - 60_000);
    const sameSecond = claims(now);
    await list.revokeUser(sub, now);
    now += 1_000;
    const after = claims(now);
    expect(await list.check(before)).toBe('token_revoked');
    expect(await list.check(sameSecond)).toBe('token_revoked');
    expect(await list.check(after)).toBe('live');
    expect(await list.check({ ...before, sub: newId('usr') })).toBe('live');
    // Callers that pass no sub or iat (B017's older checks) are unaffected.
    expect(await list.check({ jti: before.jti, scp: 'profile' })).toBe('live');
  });

  it('decides a staff-revoked refresh token as revoked, a spent one still as reuse', () => {
    const base = {
      used_at: null,
      client_id: 'centcom-cli' as const,
      expires_at: new Date(10_000),
      absolute_expires_at: new Date(20_000),
    };
    const ctx = { nowMs: 1_000, clientId: 'centcom-cli', deviceRevoked: false };
    expect(
      decideRotation({ ...base, revoked_at: new Date(500), revoked_reason: 'staff' }, ctx),
    ).toBe('revoked');
    expect(decideRotation({ ...base, revoked_at: new Date(500), revoked_reason: null }, ctx)).toBe(
      'invalid',
    );
    expect(decideRotation({ ...base, revoked_at: new Date(500) }, ctx)).toBe('invalid');
    expect(
      decideRotation(
        { ...base, used_at: new Date(400), revoked_at: new Date(500), revoked_reason: 'staff' },
        ctx,
      ),
    ).toBe('reuse');
    expect(decideRotation({ ...base, revoked_at: null, revoked_reason: null }, ctx)).toBe('rotate');
  });
});
