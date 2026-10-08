/**
 * The device flow end to end (B016 acceptance 1-4 and 8; card test flow.test.ts): a terminal
 * starts a grant and polls `POST /v1/auth/token`, a test plays the browser through the service,
 * and a fake clock moves time. Pending, slow_down, approve, deny, expiry and single use.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVAL_S,
  DEVICE_CLIENT_SCOPES,
  DEVICE_GRANT_TTL_S,
} from '../../../../src/modules/auth/device/service.js';
import { claimsOf, deviceHarness, someUser, startBody } from './helpers.js';

describe('starting a grant (acceptance 1)', () => {
  it('returns the codes, expires_in 600 and interval 5, never cached', async () => {
    const h = await deviceHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/device/code',
      payload: startBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual({
      device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      user_code: expect.stringMatching(/^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/),
      verification_uri: 'https://centcom.dev/device',
      verification_uri_complete: `https://centcom.dev/device?user_code=${String(body['user_code'])}`,
      expires_in: 600,
      interval: 5,
    });
    expect(DEVICE_GRANT_TTL_S).toBe(600);
    expect(DEFAULT_INTERVAL_S).toBe(5);
  });

  it('gives every grant its own codes', async () => {
    const h = await deviceHarness();
    const a = await h.start();
    const b = await h.start();
    expect(a.body['device_code']).not.toBe(b.body['device_code']);
    expect(a.body['user_code']).not.toBe(b.body['user_code']);
  });
});

describe('polling (acceptance 2-4)', () => {
  it('is pending, then slow_down when too fast, and the stored interval grows to 10 s (acceptance 2)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const code = String(body['device_code']);

    const first = await h.poll(code);
    expect(first.status).toBe(400);
    expect(first.body).toMatchObject({ code: 'authorization_pending', retry_after_s: 5 });

    h.clock.advance(2_000);
    const tooSoon = await h.poll(code);
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body).toMatchObject({ code: 'slow_down', retry_after_s: 10 });
    expect([...h.store.rows.values()][0]?.intervalS).toBe(10);

    // 10 s now: 6 s is still too soon, 10 s is not.
    h.clock.advance(6_000);
    expect((await h.poll(code)).body).toMatchObject({ code: 'slow_down', retry_after_s: 15 });
    h.clock.advance(15_000);
    expect((await h.poll(code)).body).toMatchObject({
      code: 'authorization_pending',
      retry_after_s: 15,
    });
  });

  it('after approval returns tokens bound to a new device, once (acceptance 3)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const code = String(body['device_code']);
    expect((await h.poll(code)).body['code']).toBe('authorization_pending');

    const userId = someUser();
    await h.service.approveDeviceGrant(String(body['user_code']), userId);
    h.clock.advance(5_000);
    const ok = await h.poll(code);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const deviceId = String(ok.body['device']);
    expect(deviceId).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ok.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      scope: DEVICE_CLIENT_SCOPES.join(' '),
      user: userId,
      device: deviceId,
    });
    const claims = claimsOf(String(ok.body['access_token']));
    expect(claims).toMatchObject({ sub: userId, dev: deviceId });
    expect(Number(claims['exp']) - Number(claims['iat'])).toBe(15 * 60);
    // The token is a real one: the service verifies it.
    await expect(
      h.tokens.verifyAccessToken(String(ok.body['access_token'])),
    ).resolves.toMatchObject({ dev: deviceId });

    // The device is registered with the terminal's name, keys and platform.
    expect(h.store.devices.get(deviceId)).toMatchObject({
      userId,
      name: 'build-box',
      platform: 'linux',
    });

    h.clock.advance(5_000);
    const again = await h.poll(code);
    expect(again.status).toBe(400);
    expect(again.body['code']).toBe('expired_token');
    expect(h.store.devices.size).toBe(1);
  });

  it('returns tokens on the first poll after approval even when it comes early', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    expect((await h.poll(String(body['device_code']))).body['code']).toBe('authorization_pending');
    await h.service.approveDeviceGrant(String(body['user_code']), someUser());
    expect((await h.poll(String(body['device_code']))).status).toBe(200);
  });

  it('the refresh token then works like any other (B017 rotation)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    await h.service.approveDeviceGrant(String(body['user_code']), someUser());
    const ok = await h.poll(String(body['device_code']));
    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: {
        grant_type: 'refresh_token',
        client_id: 'centcom-cli',
        refresh_token: ok.body['refresh_token'],
      },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ device: ok.body['device'] });
  });

  it('is expired_token after 600 s, approved or not (acceptance 4)', async () => {
    const h = await deviceHarness();
    const waiting = await h.start();
    const approved = await h.start();
    await h.service.approveDeviceGrant(String(approved.body['user_code']), someUser());
    h.clock.advance(599_999);
    expect((await h.poll(String(waiting.body['device_code']))).body['code']).toBe(
      'authorization_pending',
    );
    h.clock.advance(1);
    for (const grant of [waiting, approved]) {
      const res = await h.poll(String(grant.body['device_code']));
      expect(res.status).toBe(400);
      expect(res.body['code']).toBe('expired_token');
    }
    expect(h.store.devices.size).toBe(0);
  });

  it('cannot be approved after it expired', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    h.clock.advance(600_000);
    await expect(
      h.service.approveDeviceGrant(String(body['user_code']), someUser()),
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('is access_denied after denyDeviceGrant, on every poll (acceptance 4)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    await h.service.denyDeviceGrant(String(body['user_code']), someUser());
    for (let i = 0; i < 2; i++) {
      const res = await h.poll(String(body['device_code']));
      expect(res.status).toBe(403);
      expect(res.body['code']).toBe('access_denied');
      h.clock.advance(5_000);
    }
    expect(h.store.devices.size).toBe(0);
  });

  it('cannot be approved twice, by another user, or after a denial (guardrails)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const userCode = String(body['user_code']);
    const owner = someUser();
    await h.service.approveDeviceGrant(userCode, owner);
    await expect(h.service.approveDeviceGrant(userCode, owner)).rejects.toMatchObject({
      code: 'expired_token',
    });
    await expect(h.service.approveDeviceGrant(userCode, someUser())).rejects.toMatchObject({
      code: 'expired_token',
    });
    await expect(h.service.denyDeviceGrant(userCode, someUser())).rejects.toMatchObject({
      code: 'expired_token',
    });
    const ok = await h.poll(String(body['device_code']));
    expect(ok.body['user']).toBe(owner);

    const denied = await h.start();
    await h.service.denyDeviceGrant(String(denied.body['user_code']), owner);
    await expect(
      h.service.approveDeviceGrant(String(denied.body['user_code']), owner),
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('accepts the user code typed in lower case or without the hyphen', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const typed = String(body['user_code']).toLowerCase().replace('-', '');
    await h.service.approveDeviceGrant(` ${typed} `, someUser());
    expect((await h.poll(String(body['device_code']))).status).toBe(200);
  });

  it('does not answer a poll from another client than the one that started (guardrail)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    await h.service.approveDeviceGrant(String(body['user_code']), someUser());
    const other = await h.poll(String(body['device_code']), 'centcom-tui');
    expect(other.status).toBe(400);
    expect(other.body['code']).toBe('expired_token');
    // The grant is untouched: its own client still gets the tokens.
    expect((await h.poll(String(body['device_code']))).status).toBe(200);
  });

  it('leaves no device and keeps the approval when issuing the tokens fails (guardrail)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    await h.service.approveDeviceGrant(String(body['user_code']), someUser());
    const issue = h.tokens.issueTokens.bind(h.tokens);
    let failures = 1;
    h.tokens.issueTokens = (input, tx) => {
      if (failures-- > 0) return Promise.reject(new Error('signing key unavailable'));
      return issue(input, tx);
    };
    const failed = await h.poll(String(body['device_code']));
    expect(failed.status).toBe(500);
    expect(h.store.devices.size).toBe(0);
    expect(h.refresh.devices.size).toBe(0);
    expect([...h.store.rows.values()][0]?.status).toBe('approved');

    const retried = await h.poll(String(body['device_code']));
    expect(retried.status).toBe(200);
    expect(h.store.devices.size).toBe(1);
  });
});

describe('scopes (acceptance 8)', () => {
  const grantedScope = async (scope: string | undefined): Promise<unknown> => {
    const h = await deviceHarness();
    const { body } = await h.start(startBody(scope === undefined ? {} : { scope }));
    await h.service.approveDeviceGrant(String(body['user_code']), someUser());
    const ok = await h.poll(String(body['device_code']));
    return ok.body['scope'];
  };

  it('defaults to the CLI scope', async () => {
    expect(await grantedScope(undefined)).toBe(
      'profile workspaces:read sessions:read sessions:write sessions:host usage:write billing:read',
    );
  });

  it('is the requested scope intersected with the CLI scope; admin is never granted', async () => {
    expect(await grantedScope('admin sessions:read webhooks:write profile')).toBe(
      'profile sessions:read',
    );
    expect(await grantedScope('sessions:host  admin')).toBe('sessions:host');
  });

  it('refuses a request that leaves nothing to grant with invalid_scope', async () => {
    const h = await deviceHarness();
    for (const scope of ['admin', 'audit:read webhooks:write', '', 'nonsense']) {
      const res = await h.start(startBody({ scope }));
      expect(res.status, scope).toBe(400);
      expect(res.body['code']).toBe('invalid_scope');
    }
  });
});

describe('the device row', () => {
  it.each([
    ['centcom-cli/1.4.2 (contract/1.0.0; linux-x64; node/22.9.0)', 'centcom-cli', 'linux'],
    ['centcom-tui/1.4.2 (contract/1.0.0; darwin-arm64; node/22.9.0)', 'centcom-tui', 'macos'],
    ['centcom-cli/1.4.2 (contract/1.0.0; win32-x64; node/22.9.0)', 'centcom-cli', 'windows'],
    ['curl/8.0', 'centcom-cli', 'other'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'centcom-web', 'web'],
  ])(
    'takes its platform from the User-Agent %j (%s): %s',
    async (userAgent, clientId, platform) => {
      const h = await deviceHarness();
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/device/code',
        headers: { 'user-agent': userAgent },
        payload: startBody({ client_id: clientId }),
      });
      expect(res.statusCode).toBe(200);
      expect([...h.store.rows.values()][0]?.platform).toBe(platform);
    },
  );
});
