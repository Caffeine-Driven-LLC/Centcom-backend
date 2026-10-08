/**
 * Revocation end to end (B020 acceptance 3 and 7; tests "revoke-integration.test.ts"): after
 * `DELETE /v1/devices/{id}` the device's access token gets 401 `device_revoked` at once and its
 * refresh token is refused (400 `invalid_grant`, CT-AUTH's token endpoint codes); DELETE answers
 * 204 every time; exactly one `{device, user}` message reaches a `devices:revoked` subscriber,
 * and revoking an already revoked device publishes nothing. Other devices keep working.
 */
import { describe, expect, it } from 'vitest';
import { DEVICES_REVOKED_CHANNEL } from '../../../src/modules/devices/service.js';
import { bearer, devicesApp, listen, newId } from './helpers.js';

describe('DELETE /v1/devices/{id}', () => {
  it("kills the device's tokens, answers 204 twice, and announces once", async () => {
    const h = await devicesApp();
    const relay = await listen(h.redis.pubsub, DEVICES_REVOKED_CHANNEL);
    const alice = newId('usr');
    const laptop = await h.addDevice(alice);
    const phone = await h.addDevice(alice, { name: 'Phone', platform: 'other' });
    const lost = await h.signIn(alice, laptop.id);
    const kept = await h.signIn(alice, phone.id);

    const first = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${laptop.id}`,
      headers: bearer(kept.access_token),
    });
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe('');

    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(lost.access_token),
    });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toMatchObject({ code: 'device_revoked' });

    const refresh = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: {
        grant_type: 'refresh_token',
        refresh_token: lost.refresh_token,
        client_id: 'centcom-cli',
      },
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json()).toMatchObject({ code: 'invalid_grant' });

    const again = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${laptop.id}`,
      headers: bearer(kept.access_token),
    });
    expect(again.statusCode).toBe(204);
    expect(relay).toEqual([JSON.stringify({ device: laptop.id, user: alice })]);

    // The other device is untouched.
    const list = await h.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(kept.access_token),
    });
    expect(list.statusCode).toBe(200);
    const devices = list.json<{ data: { id: string; revoked_at: string | null }[] }>().data;
    expect(devices.find((d) => d.id === laptop.id)?.revoked_at).toEqual(expect.any(String));
    expect(devices.find((d) => d.id === phone.id)?.revoked_at).toBeNull();
    await h.app.close();
  });

  it('lets a device revoke itself, after which its own token is dead', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const laptop = await h.addDevice(alice);
    const tokens = await h.signIn(alice, laptop.id);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/v1/auth/devices/${laptop.id}`,
      headers: bearer(tokens.access_token),
    });
    expect(res.statusCode).toBe(204);
    const after = await h.app.inject({
      method: 'DELETE',
      url: `/v1/auth/devices/${laptop.id}`,
      headers: bearer(tokens.access_token),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'device_revoked' });
    await h.app.close();
  });

  it("answers 404 for another user's device and revokes nothing", async () => {
    const h = await devicesApp();
    const relay = await listen(h.redis.pubsub, DEVICES_REVOKED_CHANNEL);
    const alice = newId('usr');
    const bob = newId('usr');
    const laptop = await h.addDevice(alice);
    const { access_token: token } = await h.signIn(bob, null);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${laptop.id}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
    expect(relay).toEqual([]);
    expect(h.refresh.devices.get(laptop.id)?.revoked).toBe(false);
    await h.app.close();
  });
});
