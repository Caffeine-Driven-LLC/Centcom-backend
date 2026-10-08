/**
 * The device routes (B020 acceptance 1 and 8; tests "routes.test.ts"): a user lists only their own
 * devices, newest first, in CT-PAGE pages with a cursor bound to them; `GET /v1/devices/{id}`
 * answers the owner and 404 to anyone else; the CT-AUTH aliases answer exactly as the canonical
 * routes; an API key gets 403; no token is 401 and a missing scope 403. Bodies validate against
 * the generated `Device` and `DevicePage` and carry no key material.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { bearer, devicesApp, newId } from './helpers.js';

type DevicePage = {
  data: { id: string; current?: boolean }[];
  next_cursor: string | null;
  has_more: boolean;
};

describe('GET /v1/devices', () => {
  it('lists only the caller’s devices, newest first, marking the current one', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const bob = newId('usr');
    const older = await h.addDevice(alice, { name: 'Old' });
    const newer = await h.addDevice(alice, { name: 'New', platform: 'web' });
    await h.addDevice(bob);
    const { access_token: token } = await h.signIn(alice, newer.id);
    const res = await h.app.inject({ method: 'GET', url: '/v1/devices', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.json<DevicePage>();
    expect(validate('api/DevicePage', body).ok).toBe(true);
    expect(body.data.map((d) => d.id)).toEqual([newer.id, older.id]);
    expect(body.data.map((d) => d.current)).toEqual([true, false]);
    expect(body).toMatchObject({ next_cursor: null, has_more: false });
    expect(res.body).not.toContain(h.memory.rows.get(older.id)?.x25519_pub ?? '-');
    await h.app.close();
  });

  it('pages with a cursor that only works for its user', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.unshift((await h.addDevice(alice, { name: `D${i}` })).id);
    const { access_token: token } = await h.signIn(alice, null);
    const seen: string[] = [];
    let url = '/v1/devices?limit=2';
    for (let pages = 0; pages < 5; pages += 1) {
      const res = await h.app.inject({ method: 'GET', url, headers: bearer(token) });
      expect(res.statusCode).toBe(200);
      const body = res.json<DevicePage>();
      seen.push(...body.data.map((d) => d.id));
      if (body.next_cursor === null) break;
      url = `/v1/devices?limit=2&cursor=${encodeURIComponent(body.next_cursor)}`;
    }
    expect(seen).toEqual(ids);

    const first = await h.app.inject({
      method: 'GET',
      url: '/v1/devices?limit=2',
      headers: bearer(token),
    });
    const cursor = first.json<DevicePage>().next_cursor ?? '';
    const bob = await h.signIn(newId('usr'), null);
    const stolen = await h.app.inject({
      method: 'GET',
      url: `/v1/devices?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: bearer(bob.access_token),
    });
    expect(stolen.statusCode).toBe(400);
    const tooMany = await h.app.inject({
      method: 'GET',
      url: '/v1/devices?limit=201',
      headers: bearer(token),
    });
    expect(tooMany.statusCode).toBe(422);
    await h.app.close();
  });

  it('answers an API key with 403, no token with 401, a token without profile with 403', async () => {
    const h = await devicesApp();
    const key = await h.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(`cen_live_${'b'.repeat(32)}`),
    });
    expect(key.statusCode).toBe(403);
    expect(key.json()).toMatchObject({ code: 'forbidden' });
    const anonymous = await h.app.inject({ method: 'GET', url: '/v1/devices' });
    expect(anonymous.statusCode).toBe(401);
    const { access_token: token } = await h.signIn(newId('usr'), null, ['sessions:read']);
    const scoped = await h.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(token),
    });
    expect(scoped.statusCode).toBe(403);
    await h.app.close();
  });
});

describe('GET /v1/devices/{id}', () => {
  it('answers the owner with the device, and anyone else with 404', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const device = await h.addDevice(alice, { platform: 'windows' });
    const own = await h.signIn(alice, device.id);
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${device.id}`,
      headers: bearer(own.access_token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(validate('api/Device', body).ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      [
        'created_at',
        'current',
        'id',
        'key_fingerprint',
        'last_seen_at',
        'name',
        'platform',
        'revoked_at',
      ].sort(),
    );
    expect(body).toMatchObject({ id: device.id, platform: 'windows', current: true });
    const other = await h.signIn(newId('usr'), null);
    for (const id of [device.id, newId('dev'), 'nope']) {
      const res404 = await h.app.inject({
        method: 'GET',
        url: `/v1/devices/${id}`,
        headers: bearer(other.access_token),
      });
      expect(res404.statusCode).toBe(404);
      expect(res404.json()).toMatchObject({ code: 'not_found' });
    }
    await h.app.close();
  });
});

describe('the CT-AUTH aliases', () => {
  it('list and revoke exactly as the canonical routes', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const a = await h.addDevice(alice);
    await h.addDevice(alice, { name: 'Second' });
    const { access_token: token } = await h.signIn(alice, null);
    const canonical = await h.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(token),
    });
    const alias = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/devices',
      headers: bearer(token),
    });
    expect(alias.statusCode).toBe(200);
    expect(alias.json()).toEqual(canonical.json());
    const revoked = await h.app.inject({
      method: 'DELETE',
      url: `/v1/auth/devices/${a.id}`,
      headers: bearer(token),
    });
    expect(revoked.statusCode).toBe(204);
    const missing = await h.app.inject({
      method: 'DELETE',
      url: `/v1/auth/devices/${newId('dev')}`,
      headers: bearer(token),
    });
    expect(missing.statusCode).toBe(404);
    const key = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/devices',
      headers: bearer(`cen_live_${'c'.repeat(32)}`),
    });
    expect(key.statusCode).toBe(403);
    await h.app.close();
  });
});
