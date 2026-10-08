/**
 * `GET /v1/devices/{id}/keys` (B020 acceptance 5; tests "keys-access.test.ts"): the access matrix
 * (self, session peer, stranger, revoked device, unknown and malformed ids), the `sessions:read`
 * scope, API keys refused, and a body that validates against `DeviceKeys` with public keys only.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { bearer, devicesApp, newId } from './helpers.js';

describe('GET /v1/devices/{id}/keys', () => {
  it('answers the owner, a peer sharing a session, and nobody else', async () => {
    const h = await devicesApp();
    const owner = newId('usr');
    const peer = newId('usr');
    const stranger = newId('usr');
    const device = await h.addDevice(owner);
    h.memory.shareASession(owner, peer);
    h.memory.shareASession(stranger, newId('usr'));
    const row = h.memory.rows.get(device.id);

    for (const [user, status] of [
      [owner, 200],
      [peer, 200],
      [stranger, 404],
    ] as const) {
      const { access_token: token } = await h.signIn(user, null);
      const res = await h.app.inject({
        method: 'GET',
        url: `/v1/devices/${device.id}/keys`,
        headers: bearer(token),
      });
      expect(res.statusCode).toBe(status);
      if (status === 200) {
        const body = res.json<Record<string, unknown>>();
        expect(validate('api/DeviceKeys', body).ok).toBe(true);
        expect(body).toEqual({
          device: device.id,
          x25519: row?.x25519_pub,
          ed25519: row?.ed25519_pub,
          fingerprint: device.key_fingerprint,
          revoked: false,
        });
        expect(res.headers['cache-control']).toBe('private, no-store');
      } else {
        expect(res.json()).toMatchObject({ code: 'not_found' });
      }
    }
    await h.app.close();
  });

  it('still answers for a revoked device, with revoked: true', async () => {
    const h = await devicesApp();
    const owner = newId('usr');
    const peer = newId('usr');
    const device = await h.addDevice(owner);
    h.memory.shareASession(owner, peer);
    await h.devices.revokeDevice(owner, device.id);
    const { access_token: token } = await h.signIn(peer, null);
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${device.id}/keys`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ device: device.id, revoked: true });
    await h.app.close();
  });

  it.each([
    ['an unknown device', () => newId('dev')],
    ['a malformed id', () => 'dev_nope'],
    ['another kind of id', () => newId('usr')],
  ])('answers %s with 404', async (_case, id) => {
    const h = await devicesApp();
    const { access_token: token } = await h.signIn(newId('usr'), null);
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${id()}/keys`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(404);
    await h.app.close();
  });

  it('needs the sessions:read scope, and a user', async () => {
    const h = await devicesApp();
    const owner = newId('usr');
    const device = await h.addDevice(owner);
    const { access_token: token } = await h.signIn(owner, null, ['profile']);
    const scoped = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${device.id}/keys`,
      headers: bearer(token),
    });
    expect(scoped.statusCode).toBe(403);
    const key = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${device.id}/keys`,
      headers: bearer(`cen_live_${'a'.repeat(32)}`),
    });
    expect(key.statusCode).toBe(403);
    expect(key.json()).toMatchObject({ code: 'forbidden' });
    await h.app.close();
  });
});
