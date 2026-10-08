/**
 * RFC 8628 over HTTP (B016; card test rfc8628.test.ts): the answers of `POST /v1/auth/token` with
 * the device_code grant are CT-ERR problem bodies with the registry's statuses, `retry_after_s`
 * and `Retry-After` on the retryable ones, polls work as forms (RFC 8628 §3.4) and as JSON, and a
 * database outage is a 503 the terminal keeps polling through.
 */
import { fastify } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEVICE_CODE_GRANT_TYPE } from '../../../../src/modules/auth/device/grant-handler.js';
import { deviceRoutes } from '../../../../src/modules/auth/device/routes.js';
import type { DeviceGrantStore } from '../../../../src/modules/auth/device/store.js';
import { deviceHarness, memoryGrantStore, someUser } from './helpers.js';

const PROBLEM = 'application/problem+json';

describe('poll answers', () => {
  it.each([
    ['authorization_pending', 400, 5, 'https://centcom.dev/errors/authorization_pending'],
    ['slow_down', 400, 10, 'https://centcom.dev/errors/slow_down'],
    ['access_denied', 403, undefined, 'https://centcom.dev/errors/access_denied'],
    ['expired_token', 400, undefined, 'https://centcom.dev/errors/expired_token'],
  ])('%s is a %i problem (retry_after_s %s)', async (code, status, retryAfter, type) => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const deviceCode = String(body['device_code']);
    if (code === 'slow_down') await h.poll(deviceCode);
    if (code === 'access_denied')
      await h.service.denyDeviceGrant(String(body['user_code']), someUser());
    if (code === 'expired_token') h.clock.advance(600_000);
    const res = await h.poll(deviceCode);
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toBe(PROBLEM);
    expect(res.body).toMatchObject({ type, status, code, detail: expect.any(String) });
    expect(res.body['request_id']).toMatch(/^req_/);
    if (retryAfter === undefined) {
      expect(res.body).not.toHaveProperty('retry_after_s');
      expect(res.headers['retry-after']).toBeUndefined();
    } else {
      expect(res.body['retry_after_s']).toBe(retryAfter);
      expect(res.headers['retry-after']).toBe(String(retryAfter));
    }
  });

  it('work with a JSON body as well as a form', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: body['device_code'],
        client_id: 'centcom-cli',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'authorization_pending' });
  });

  it('refuse a poll without a device_code with invalid_request', async () => {
    const h = await deviceHarness();
    for (const extra of [{}, { device_code: '' }]) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/auth/token',
        payload: { grant_type: DEVICE_CODE_GRANT_TYPE, client_id: 'centcom-cli', ...extra },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_request' });
    }
  });

  it('refuse an unknown client before looking at the grant (invalid_client, 401)', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    const res = await h.poll(String(body['device_code']), 'centcom-desktop');
    expect(res.status).toBe(401);
    expect(res.body['code']).toBe('invalid_client');
  });

  it('give tokens with Cache-Control: no-store', async () => {
    const h = await deviceHarness();
    const { body } = await h.start();
    await h.service.approveDeviceGrant(String(body['user_code']), someUser());
    const res = await h.poll(String(body['device_code']));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });
});

describe('a database outage (failure mode)', () => {
  const down = (): Error =>
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });

  it('is a 503 with retry_after_s for a poll, and the next poll works', async () => {
    let failing = true;
    const store = memoryGrantStore(new Map());
    const flaky: DeviceGrantStore = {
      ...store,
      poll: (...args) => (failing ? Promise.reject(down()) : store.poll(...args)),
    };
    const h = await deviceHarness({ store: flaky });
    const { body } = await h.start();
    const res = await h.poll(String(body['device_code']));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'service_unavailable', retry_after_s: 5 });
    expect(res.headers['retry-after']).toBe('5');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.1');
    failing = false;
    expect((await h.poll(String(body['device_code']))).body['code']).toBe('authorization_pending');
  });

  it('is a 503 for a start', async () => {
    const store = memoryGrantStore(new Map());
    const h = await deviceHarness({ store: { ...store, insert: () => Promise.reject(down()) } });
    const res = await h.start();
    expect(res.status).toBe(503);
    expect(res.body['code']).toBe('service_unavailable');
  });
});

describe('the start route', () => {
  it('counts in the auth rate-limit bucket, needs no credential and reads at most 8 KiB', async () => {
    const seen: { url: string; config: unknown; bodyLimit: unknown }[] = [];
    const app = fastify({ logger: false });
    app.addHook('onRoute', (route) => {
      seen.push({ url: route.url, config: route.config, bodyLimit: route.bodyLimit });
    });
    const h = await deviceHarness();
    await app.register(deviceRoutes, { devices: h.service });
    await app.ready();
    expect(seen).toEqual([
      {
        url: '/v1/auth/device/code',
        config: { auth: false, rateLimit: { bucket: 'auth' } },
        bodyLimit: 8 * 1024,
      },
    ]);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/device/code',
      headers: { authorization: 'Bearer not-a-token' },
      payload: {},
    });
    // Validation, not authentication, answers: the route is public.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'invalid_client' });
  });

  it('refuses a body over 8 KiB', async () => {
    const h = await deviceHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/device/code',
      payload: { client_id: 'centcom-cli', device_name: 'x'.repeat(9000) },
    });
    expect(res.statusCode).toBe(413);
  });
});
