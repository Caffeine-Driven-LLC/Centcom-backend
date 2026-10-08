/**
 * Device flow security (B016 acceptance 6 and 7, guardrails; card test security.test.ts): the
 * device_code is kept only as its hash, wrong user codes lock the user and the address out, a
 * wrong code and an expired or used one look the same, and no code or token reaches the logs.
 */
import { createHash } from 'node:crypto';
import { toProblem } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  LOOKUP_FAILURE_LIMIT,
  LOOKUP_LOCKOUT_MS,
  USER_CODE_INVALID_DETAIL,
} from '../../../../src/modules/auth/device/service.js';
import { deviceHarness, someUser, type DeviceHarness } from './helpers.js';

const wrong = (n: number): string => `ZZZZ-${String(n).padStart(4, '2').replace(/[01]/g, '9')}`;
const attempt = (userId: string | null, ip: string | null = null) => ({ userId, ip });

/** Ten wrong codes from `who`, 30 s apart (the lock starts with the tenth, at +270 s). */
async function tenWrong(h: DeviceHarness, who: { userId: string | null; ip: string | null }) {
  for (let i = 0; i < LOOKUP_FAILURE_LIMIT; i++) {
    expect(await h.service.lookupUserCode(wrong(i), who)).toBeNull();
    h.clock.advance(30_000);
  }
}

describe('the device_code at rest (acceptance 6)', () => {
  it('is stored only as its sha256: nothing stored is or contains the code', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const code = String(body['device_code']);
    const [row] = [...h.store.rows.values()];
    expect(row?.deviceCodeHash).toBe(createHash('sha256').update(code).digest('hex'));
    const dump = JSON.stringify([...h.store.rows.entries()]);
    expect(dump).not.toContain(code);
    // A stored value used as a device_code gets nowhere.
    expect((await h.poll(row?.deviceCodeHash ?? '')).body['code']).toBe('expired_token');
  });
});

describe('wrong user codes (acceptance 7)', () => {
  it('lock a user out for 15 minutes after 10 within 10 minutes, even for the right code', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const userId = someUser();
    await tenWrong(h, attempt(userId));

    const locked = h.service.lookupUserCode(String(body['user_code']), attempt(userId));
    await expect(locked).rejects.toMatchObject({ code: 'rate_limited', retryAfterS: 900 - 30 });
    await expect(
      h.service.approveDeviceGrant(String(body['user_code']), userId),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(
      h.service.denyDeviceGrant(String(body['user_code']), userId),
    ).rejects.toMatchObject({
      code: 'rate_limited',
    });

    // Someone else is not affected.
    expect(
      await h.service.lookupUserCode(String(body['user_code']), attempt(someUser())),
    ).not.toBeNull();

    // The lock ends 15 minutes after the tenth wrong code; the first grant has expired by then.
    h.clock.advance(LOOKUP_LOCKOUT_MS - 30_000 - 1);
    await expect(h.service.lookupUserCode(wrong(1), attempt(userId))).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterS: 1,
    });
    h.clock.advance(1);
    const fresh = await h.start();
    const after = await h.service.lookupUserCode(String(fresh.body['user_code']), attempt(userId));
    expect(after).toMatchObject({
      userCode: fresh.body['user_code'],
      clientId: 'centcom-cli',
      deviceName: 'build-box',
      platform: 'linux',
      scopes: [
        'profile',
        'workspaces:read',
        'sessions:read',
        'sessions:write',
        'sessions:host',
        'usage:write',
        'billing:read',
      ],
      fingerprint: expect.stringMatching(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/),
    });
  });

  it('lock an address out whoever is signed in', async () => {
    const h = await deviceHarness();
    for (let i = 0; i < LOOKUP_FAILURE_LIMIT; i++) {
      await h.service.lookupUserCode(wrong(i), attempt(someUser(), '203.0.113.9'));
    }
    await expect(
      h.service.lookupUserCode(wrong(99), attempt(null, '203.0.113.9')),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(
      h.service.approveDeviceGrant(wrong(98), someUser(), '203.0.113.9'),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await h.service.lookupUserCode(wrong(97), attempt(null, '198.51.100.1'))).toBeNull();
  });

  it('count wrong approvals and denials too', async () => {
    const h = await deviceHarness();
    const userId = someUser();
    for (let i = 0; i < LOOKUP_FAILURE_LIMIT; i++) {
      const decide = i % 2 === 0 ? h.service.approveDeviceGrant : h.service.denyDeviceGrant;
      await expect(decide.call(h.service, wrong(i), userId)).rejects.toMatchObject({
        code: 'expired_token',
      });
    }
    await expect(h.service.lookupUserCode(wrong(50), attempt(userId))).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('do not lock anyone when spread over more than 10 minutes', async () => {
    const h = await deviceHarness();
    const userId = someUser();
    for (let i = 0; i < 2 * LOOKUP_FAILURE_LIMIT; i++) {
      expect(await h.service.lookupUserCode(wrong(i), attempt(userId))).toBeNull();
      h.clock.advance(70_000);
    }
  });

  it('keep no raw address in the counters', async () => {
    const h = await deviceHarness();
    await h.service.lookupUserCode(wrong(1), attempt(null, '203.0.113.9'));
    const keys: string[] = [];
    const kv = h.redis.kv;
    for (const key of ['device-grant:fail:ip:203.0.113.9']) {
      if ((await kv.get(key)) !== null) keys.push(key);
    }
    expect(keys).toEqual([]);
  });
});

describe('one answer for wrong, expired and used codes (acceptance 7, guardrail)', () => {
  it('lookups give null for all of them', async () => {
    const h = await deviceHarness();
    const expired = await h.start();
    h.clock.advance(600_000);
    const used = await h.start();
    await h.service.approveDeviceGrant(String(used.body['user_code']), someUser());
    const who = attempt(someUser());
    expect(await h.service.lookupUserCode(wrong(1), who)).toBeNull();
    expect(await h.service.lookupUserCode(String(expired.body['user_code']), who)).toBeNull();
    expect(await h.service.lookupUserCode(String(used.body['user_code']), who)).toBeNull();
    expect(await h.service.lookupUserCode('not a code', who)).toBeNull();
  });

  it('approvals fail with the same problem body for all of them', async () => {
    const h = await deviceHarness();
    const expired = await h.start();
    h.clock.advance(600_000);
    const used = await h.start();
    await h.service.approveDeviceGrant(String(used.body['user_code']), someUser());
    const bodies: unknown[] = [];
    for (const code of [
      wrong(1),
      String(expired.body['user_code']),
      String(used.body['user_code']),
      '?',
    ]) {
      const err = await h.service.approveDeviceGrant(code, someUser()).catch((e: unknown) => e);
      bodies.push(toProblem(err, { requestId: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W' }));
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({
      status: 400,
      code: 'expired_token',
      detail: USER_CODE_INVALID_DETAIL,
    });
  });

  it('polls get the same body for an unknown, malformed, expired, used or foreign device_code', async () => {
    const h = await deviceHarness();
    const expired = await h.start();
    const used = await h.start();
    await h.service.approveDeviceGrant(String(used.body['user_code']), someUser());
    await h.poll(String(used.body['device_code']));
    const foreign = await h.start();
    h.clock.advance(600_000);
    const stable = (b: Record<string, unknown>) => ({ ...b, request_id: undefined });
    const answers = [
      await h.poll('A'.repeat(43)),
      await h.poll('not-a-device-code'),
      await h.poll(String(expired.body['device_code'])),
      await h.poll(String(used.body['device_code'])),
      await h.poll(String(foreign.body['device_code']), 'centcom-tui'),
    ];
    for (const a of answers) expect(a.status).toBe(400);
    expect(new Set(answers.map((a) => JSON.stringify(stable(a.body)))).size).toBe(1);
  });
});

describe('the logs', () => {
  it('never hold a device_code, a user_code or a token', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    await h.poll(String(body['device_code']));
    await h.service.lookupUserCode(String(body['user_code']), attempt(someUser()));
    for (let i = 0; i < LOOKUP_FAILURE_LIMIT; i++) {
      await h.service.lookupUserCode(wrong(i), attempt(someUser(), '203.0.113.9'));
    }
    await h.service.approveDeviceGrant(String(body['user_code']), someUser());
    const ok = await h.poll(String(body['device_code']));
    const logs = h.logs();
    expect(logs).toContain('auth.device_grant.started');
    expect(logs).toContain('auth.device_grant.decided');
    expect(logs).toContain('auth.device_grant.lookup_locked');
    for (const secret of [
      body['device_code'],
      body['user_code'],
      String(body['user_code']).replace('-', ''),
      ok.body['access_token'],
      ok.body['refresh_token'],
      '203.0.113.9',
    ]) {
      expect(logs).not.toContain(String(secret));
    }
  });
});
