/**
 * The device service (B020 acceptance 1, 3, 6 and 7; tests "service.test.ts"): ownership (another
 * user's device is a 404), idempotent revocation that announces once and audits once, a publish
 * that fails and is retried in the background, an audit sink that throws without blocking, a
 * storage failure that revokes nothing, and `touchDevice` writing at most once per 5 minutes per
 * device under 10 000 touches, with its in-process memory bounded.
 */
import { AppError, isAppError, unavailable, type PubSub } from '@centcom/core';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICES_REVOKED_CHANNEL,
  PUBLISH_ATTEMPTS,
  TOUCH_INTERVAL_MS,
  TOUCH_MEMORY_MAX,
} from '../../../src/modules/devices/service.js';
import { devicesApp, listen, newId } from './helpers.js';

const codeOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'ok',
    (err: unknown) => (isAppError(err) ? `${err.status} ${err.code}` : err),
  );

describe('ownership', () => {
  it("gives a user their own device and a 404 for anyone else's", async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const bob = newId('usr');
    const device = await h.addDevice(alice);
    expect(await h.devices.get(alice, device.id)).toMatchObject({ id: device.id });
    expect(await codeOf(h.devices.get(bob, device.id))).toBe('404 not_found');
    expect(await codeOf(h.devices.get(alice, newId('dev')))).toBe('404 not_found');
    expect(await codeOf(h.devices.get(alice, 'dev_nope'))).toBe('404 not_found');
    expect(await codeOf(h.devices.revokeDevice(bob, device.id))).toBe('404 not_found');
    expect(h.memory.rows.get(device.id)?.revoked_at).toBeNull();
    await h.app.close();
  });

  it('marks the current device only when asked who is calling', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    expect(await h.devices.get(alice, device.id, device.id)).toMatchObject({ current: true });
    expect(await h.devices.get(alice, device.id, null)).toMatchObject({ current: false });
    expect(await h.devices.get(alice, device.id)).toMatchObject({ current: false });
    await h.app.close();
  });
});

describe('revokeDevice', () => {
  it('revokes once: one announcement, one audit event, tokens revoked every time', async () => {
    const h = await devicesApp();
    const seen = await listen(h.redis.pubsub, DEVICES_REVOKED_CHANNEL);
    const revokeTokens = vi.spyOn(h.tokens, 'revokeDevice');
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    await h.devices.revokeDevice(alice, device.id, { requestId: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W' });
    await h.devices.revokeDevice(alice, device.id);
    expect(seen).toEqual([JSON.stringify({ device: device.id, user: alice })]);
    expect(revokeTokens).toHaveBeenCalledTimes(2);
    expect(h.audit.events).toEqual([
      {
        workspaceId: null,
        actor: { type: 'user', id: alice },
        action: 'auth.device_revoked',
        target: { type: 'device', id: device.id },
        outcome: 'success',
        meta: { reason: 'user' },
        requestId: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      },
    ]);
    expect(h.memory.rows.get(device.id)?.revoked_at).not.toBeNull();
    await h.app.close();
  });

  it('announces once when two revocations race', async () => {
    const h = await devicesApp();
    const seen = await listen(h.redis.pubsub, DEVICES_REVOKED_CHANNEL);
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    await Promise.all([1, 2, 3].map(() => h.devices.revokeDevice(alice, device.id)));
    expect(seen).toHaveLength(1);
    await h.app.close();
  });

  it('keeps the revocation when publishing fails, and publishes it on a retry', async () => {
    let failures = 2;
    const sent: string[] = [];
    const pubsub: Pick<PubSub, 'publish'> = {
      publish: (_channel, message) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(unavailable());
        }
        sent.push(message);
        return Promise.resolve();
      },
    };
    const waits: number[] = [];
    const h = await devicesApp({
      pubsub,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    await h.devices.revokeDevice(alice, device.id);
    await h.devices.drain();
    expect(sent).toHaveLength(1);
    expect(waits).toEqual([500, 1000]);
    expect(h.memory.rows.get(device.id)?.revoked_at).not.toBeNull();
    expect(h.refresh.devices.get(device.id)?.revoked).toBe(true);
    await h.app.close();
  });

  it('logs a revocation it could never announce, and still revokes', async () => {
    const pubsub: Pick<PubSub, 'publish'> = { publish: () => Promise.reject(new Error('down')) };
    const h = await devicesApp({ pubsub });
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    await h.devices.revokeDevice(alice, device.id);
    await h.devices.drain();
    const lines = h.captured.lines();
    expect(lines.filter((l) => l['msg'] === 'devices.revoke_publish_retry')).toHaveLength(
      PUBLISH_ATTEMPTS,
    );
    expect(lines.some((l) => String(l['msg']).startsWith('devices.revoke_publish_failed'))).toBe(
      true,
    );
    expect(h.refresh.devices.get(device.id)?.revoked).toBe(true);
    await h.app.close();
  });

  it('is not blocked by an audit sink that throws', async () => {
    const h = await devicesApp({
      audit: {
        emitDetached: () => {
          throw new Error('audit down');
        },
      },
    });
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    await h.devices.revokeDevice(alice, device.id);
    expect(h.refresh.devices.get(device.id)?.revoked).toBe(true);
    expect(h.captured.lines().some((l) => l['msg'] === 'devices.audit_failed')).toBe(true);
    await h.app.close();
  });

  it('revokes and announces nothing when storage fails, and answers 503', async () => {
    const h = await devicesApp();
    const seen = await listen(h.redis.pubsub, DEVICES_REVOKED_CHANNEL);
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    h.memory.store.markRevoked = () => Promise.reject(unavailable());
    expect(await codeOf(h.devices.revokeDevice(alice, device.id))).toBe('503 service_unavailable');
    expect(seen).toEqual([]);
    expect(h.refresh.devices.get(device.id)?.revoked).toBe(false);
    await h.app.close();
  });

  it('answers 503 when the token step fails, and finishes on a retry', async () => {
    const h = await devicesApp();
    const seen = await listen(h.redis.pubsub, DEVICES_REVOKED_CHANNEL);
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    const revoke = h.tokens.revokeDevice.bind(h.tokens);
    const spy = vi.spyOn(h.tokens, 'revokeDevice').mockRejectedValueOnce(unavailable());
    expect(await codeOf(h.devices.revokeDevice(alice, device.id))).toBe('503 service_unavailable');
    spy.mockImplementation(revoke);
    await h.devices.revokeDevice(alice, device.id);
    expect(h.refresh.devices.get(device.id)?.revoked).toBe(true);
    expect(seen).toHaveLength(1);
    await h.app.close();
  });
});

describe('touchDevice', () => {
  it('writes last_seen_at at most once per 5 minutes under 10 000 touches', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    await Promise.all(Array.from({ length: 10_000 }, () => h.devices.touchDevice(device.id)));
    expect(h.memory.counts.touchWrites).toBe(1);
    expect(h.memory.counts.touchCalls).toBe(1);
    h.clock.advance(TOUCH_INTERVAL_MS - 1);
    for (let i = 0; i < 1000; i += 1) await h.devices.touchDevice(device.id);
    expect(h.memory.counts.touchWrites).toBe(1);
    h.clock.advance(1);
    for (let i = 0; i < 1000; i += 1) await h.devices.touchDevice(device.id);
    expect(h.memory.counts.touchWrites).toBe(2);
    expect(h.memory.rows.get(device.id)?.last_seen_at?.getTime()).toBe(h.clock.now());
    await h.app.close();
  });

  it('holds across instances: the conditional write refuses a touch too soon', async () => {
    const h = await devicesApp();
    const alice = newId('usr');
    const device = await h.addDevice(alice);
    await h.devices.touchDevice(device.id);
    // Another instance (empty memory) touching a minute later: the store refuses the write.
    const other = await devicesApp({ store: h.memory.store, clock: h.clock });
    h.clock.advance(60_000);
    await other.devices.touchDevice(device.id);
    expect(h.memory.counts.touchCalls).toBe(2);
    expect(h.memory.counts.touchWrites).toBe(1);
    await other.app.close();
    await h.app.close();
  });

  it('ignores ids that are not device ids, and forgets the oldest device first', async () => {
    const h = await devicesApp();
    await h.devices.touchDevice('nope');
    expect(h.memory.counts.touchCalls).toBe(0);
    const first = newId('dev');
    await h.devices.touchDevice(first);
    for (let i = 0; i < TOUCH_MEMORY_MAX; i += 1) await h.devices.touchDevice(newId('dev'));
    const calls = h.memory.counts.touchCalls;
    await h.devices.touchDevice(first);
    expect(h.memory.counts.touchCalls).toBe(calls + 1);
    await h.app.close();
  });

  it('passes a storage failure on', async () => {
    const h = await devicesApp();
    h.memory.store.touch = () => Promise.reject(new AppError('service_unavailable'));
    expect(await codeOf(h.devices.touchDevice(newId('dev')))).toBe('503 service_unavailable');
    await h.app.close();
  });
});
