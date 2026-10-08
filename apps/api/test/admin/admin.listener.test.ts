/**
 * The admin listener (B087, acceptance 7), on real sockets:
 *
 * - a connection from outside ADMIN_ALLOWED_CIDRS is dropped before a request is read (no HTTP
 *   answer at all), one from inside is served;
 * - with ADMIN_API_ENABLED off nothing listens, and the public listener has no admin routes (404);
 * - the admin plugin refuses any instance but the admin listener's, and the admin listener any
 *   route outside /internal/admin/v1.
 */
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId } from '@centcom/contracts';
import { ConfigError } from '@centcom/core';
import { fastify } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAdminConfig, parseCidr, type Cidr } from '../../src/modules/admin/index.js';
import {
  createAdminServer,
  internalAdminPlugin,
  startAdminServer,
} from '../../src/routes/internal-admin.js';
import { authApp, memoryTokens } from '../modules/auth/tokens/helpers.js';
import { adminWorld, BASE, REASON, type AdminWorld } from './helpers.js';

let w: AdminWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const cidr = (text: string): Cidr => {
  const parsed = parseCidr(text);
  if (parsed === null) throw new Error(`bad test CIDR ${text}`);
  return parsed;
};

/** A GET to 127.0.0.1:`port`: its status, or the socket error that ended it. */
function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status?: number; error?: string }>((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
    req.setTimeout(5_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

describe('connection-level allowlist', () => {
  it('drops a connection from outside ADMIN_ALLOWED_CIDRS before reading a request', async () => {
    w = await adminWorld({ allowedCidrs: [cidr('10.0.0.0/8'), cidr('fd00::/8')] });
    await w.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = w.app.server.address() as AddressInfo;
    const staff = await w.staff('superadmin');
    const before = w.store.rows().length;
    const res = await get(port, `${BASE}/staff-audit`, {
      authorization: `Bearer ${staff.token}`,
      'x-admin-reason': REASON,
    });
    expect(res.status).toBeUndefined();
    expect(['ECONNRESET', 'EPIPE', 'ECONNREFUSED']).toContain(res.error);
    // Nothing was read, so nothing was answered or recorded.
    expect(w.store.rows()).toHaveLength(before);
    expect(w.recorded.count('admin_connections_refused_total')).toBe(1);
  });

  it('serves a connection from inside the allowlist', async () => {
    w = await adminWorld({ allowedCidrs: [cidr('127.0.0.1/32')] });
    await w.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = w.app.server.address() as AddressInfo;
    const staff = await w.staff('support_ro');
    const ok = await get(port, `${BASE}/users/${w.store.addUser().id}`, {
      authorization: `Bearer ${staff.token}`,
      'x-admin-reason': REASON,
    });
    expect(ok.status).toBe(200);
    expect((await get(port, `${BASE}/users/${newId('usr')}`)).status).toBe(401);
    expect(w.recorded.count('admin_connections_refused_total')).toBe(0);
  });

  it('starts on ADMIN_API_PORT only when enabled', async () => {
    w = await adminWorld();
    const off = await startAdminServer(
      { enabled: false, port: 0, allowedCidrs: [cidr('127.0.0.0/8')] },
      w.serverOptions,
    );
    expect(off).toBeNull();
    const on = await startAdminServer(
      { enabled: true, port: 0, allowedCidrs: [cidr('127.0.0.0/8')] },
      w.serverOptions,
      '127.0.0.1',
    );
    try {
      expect(on).not.toBeNull();
      const { port } = on?.server.address() as AddressInfo;
      expect((await get(port, `${BASE}/staff-audit`)).status).toBe(401);
    } finally {
      await on?.close();
    }
  });
});

describe('only on the admin listener', () => {
  it('has no admin routes on the public listener (404), and is off unless enabled', async () => {
    const { tokens } = memoryTokens();
    const publicApi = await authApp(tokens);
    try {
      const res = await publicApi.app.inject({
        method: 'GET',
        url: `${BASE}/users/${newId('usr')}`,
        headers: { 'x-admin-reason': REASON },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { code: string }).code).toBe('not_found');
    } finally {
      await publicApi.app.close();
    }
    expect(loadAdminConfig({}).enabled).toBe(false);
    expect(() => loadAdminConfig({ ADMIN_API_ENABLED: 'true' })).toThrow(ConfigError);
    expect(
      loadAdminConfig({
        ADMIN_API_ENABLED: 'true',
        ADMIN_API_PORT: '9090',
        ADMIN_ALLOWED_CIDRS: '10.0.0.0/8, fd00::/8',
      }),
    ).toEqual({
      enabled: true,
      port: 9090,
      allowedCidrs: [cidr('10.0.0.0/8'), cidr('fd00::/8')],
    });
    expect(() => loadAdminConfig({ ADMIN_ALLOWED_CIDRS: '10.0.0.0/33' })).toThrow(ConfigError);
  });

  it('refuses to mount the admin plugin anywhere but the admin listener', async () => {
    w = await adminWorld();
    const plain = fastify({ logger: false });
    await expect(plain.register(internalAdminPlugin, w.serverOptions).ready()).rejects.toThrow(
      /createAdminServer/,
    );
    await plain.close();

    const admin = await createAdminServer({
      ...w.serverOptions,
      allowedCidrs: [cidr('127.0.0.0/8')],
    });
    expect(() => admin.get('/v1/anything', () => ({}))).toThrow(
      /serves \/internal\/admin\/v1 only/,
    );
    await admin.close();
  });
});
