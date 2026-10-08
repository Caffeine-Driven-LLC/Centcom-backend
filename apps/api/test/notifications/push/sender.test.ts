/**
 * Sending (B064 acceptance 4, 5, 6 and 7, failure modes): the payload is valid CT-NOTIF-PAYLOAD,
 * its fields only, with params cut to the category's allow-list and trimmed to fit; logs carry the
 * subscription id and provider, never the endpoint, keys or payload; gone deletes without a
 * retry; a transient failure is retried 3 times with full-jitter backoff (base 1 s, cap 30 s) and
 * then counted, the fifth count deleting the subscription; a permanent failure is not counted;
 * 10 failures in a row open the provider's circuit and defer deliveries; an unconfigured provider
 * skips; 1 000 pushes through 10 concurrent jobs never exceed the per-provider concurrency; the
 * sender queues one job per notification and user.
 */
import { validateNotification } from '@centcom/contracts';
import { NOTIFY_PUSH_QUEUE } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_OPEN_MS,
  CIRCUIT_THRESHOLD,
} from '../../../src/modules/notifications/push/providers.js';
import {
  PUSH_PAYLOAD_BUDGET,
  PushDelivery,
  pushPayload,
  PushSender,
  type PushDeliveryDeps,
} from '../../../src/modules/notifications/push/sender.js';
import { memoryRegistry, notification, scriptedProvider, webTarget } from './helpers.js';

const USER = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const target = (n: number, kind: 'web_push' | 'apns' | 'fcm' = 'apns') => ({
  id: `psh_01JA3Z8K2M5N7P9Q0R1S2T3V${String(n).padStart(2, '0')}`.slice(0, 30),
  kind,
  token: `${'ab'.repeat(32)}${n}`,
});

function delivery(
  overrides: Partial<PushDeliveryDeps> & Pick<PushDeliveryDeps, 'registry' | 'providers'>,
) {
  const waits: number[] = [];
  let now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const d = new PushDelivery({
    concurrency: 20,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    clock: () => now,
    ...overrides,
  });
  return { d, waits, advance: (ms: number) => (now += ms) };
}

describe('pushPayload', () => {
  it('keeps the CT-NOTIF-PAYLOAD fields and the allow-listed params only', () => {
    const payload = JSON.parse(
      Buffer.from(
        pushPayload({
          ...notification(),
          params: { ...notification().params, secret: 'leak', path: '/home/x' },
          title: 'Display text',
          body: 'Never sent',
          extra: 1,
        } as Record<string, unknown>),
      ).toString(),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [
        'action',
        'body_key',
        'category',
        'created_at',
        'id',
        'params',
        'priority',
        'read_at',
        'title_key',
      ].sort(),
    );
    expect(payload['params']).toEqual(notification().params);
    expect(validateNotification(payload).ok).toBe(true);
  });

  it('caps long fields so even a maximal payload stays within the budget', () => {
    const long = 'x'.repeat(5000);
    const maxed = {
      ...notification(),
      title_key: long,
      body_key: long,
      params: { agent: long, session: long, risk: long },
      action: { type: 'open_session', deeplink: `centcom://${long}` },
    };
    const bytes = pushPayload(maxed as Record<string, unknown>);
    expect(bytes.length).toBeLessThanOrEqual(PUSH_PAYLOAD_BUDGET);
    const trimmed = JSON.parse(Buffer.from(bytes).toString()) as {
      params: Record<string, string>;
      action?: { deeplink: string };
      title_key: string;
    };
    expect(Object.values(trimmed.params).every((v) => v.length === 256)).toBe(true);
    expect(trimmed.action?.deeplink.length).toBe(1024);
    expect(trimmed.title_key.length).toBe(256);
    for (let size = 0; size < 5000; size += 500) {
      const long = 'A'.repeat(size);
      const bytes = pushPayload({
        ...notification(),
        id: `ntf_${long}`,
        title_key: long,
        body_key: long,
        params: { agent: long, session: long, risk: long },
        action: { type: 'open_session', deeplink: long },
      } as Record<string, unknown>);
      expect(bytes.length).toBeLessThanOrEqual(PUSH_PAYLOAD_BUDGET);
      expect(() => JSON.parse(Buffer.from(bytes).toString()) as unknown).not.toThrow();
    }
  });
});

describe('PushDelivery', () => {
  it('sends to every subscription and resets their failure counts', async () => {
    const registry = memoryRegistry([target(1, 'apns'), target(2, 'fcm'), target(3, 'apns')]);
    const apns = scriptedProvider('apns');
    const fcm = scriptedProvider('fcm');
    const { d } = delivery({ registry, providers: { apns, fcm } });
    expect(await d.process({ userId: USER, payload: { ...notification() } })).toEqual({
      sent: 3,
      gone: 0,
      failed: 0,
      skipped: 0,
    });
    expect(apns.sent).toHaveLength(2);
    expect(registry.calls.success).toHaveLength(3);
  });

  it('deletes a gone subscription without retrying', async () => {
    const registry = memoryRegistry([target(1)]);
    const apns = scriptedProvider('apns', ['gone']);
    const { d, waits } = delivery({ registry, providers: { apns } });
    expect(await d.process({ userId: USER, payload: { ...notification() } })).toMatchObject({
      gone: 1,
    });
    expect(apns.sent).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(registry.live.size).toBe(0);
  });

  it('retries a transient failure 3 times with full-jitter backoff, then counts it', async () => {
    const registry = memoryRegistry([target(1)]);
    const apns = scriptedProvider('apns', ['retry']);
    const { d, waits } = delivery({ registry, providers: { apns } });
    expect(await d.process({ userId: USER, payload: { ...notification() } })).toMatchObject({
      failed: 1,
    });
    expect(apns.sent).toHaveLength(4);
    expect(waits).toEqual([500, 1000, 2000]);
    expect(registry.calls.failure).toEqual([target(1).id]);
  });

  it('caps the backoff at 30 s', () => {
    const { d } = delivery({ registry: memoryRegistry([]), providers: {}, random: () => 0.999999 });
    expect(d.backoff(0)).toBe(999);
    expect(d.backoff(4)).toBe(15_999);
    expect(d.backoff(10)).toBe(29_999);
  });

  it('succeeds after a retry and does not count a failure', async () => {
    const registry = memoryRegistry([target(1)]);
    const apns = scriptedProvider('apns', ['retry', 'retry', 'sent']);
    const { d } = delivery({ registry, providers: { apns } });
    expect(await d.process({ userId: USER, payload: { ...notification() } })).toMatchObject({
      sent: 1,
    });
    expect(registry.calls.failure).toEqual([]);
  });

  it('deletes a subscription on its fifth failed send in a row', async () => {
    const registry = memoryRegistry([target(1)]);
    // A fresh delivery each time: one process's breaker would open after 10 failed sends.
    const run = () =>
      delivery({ registry, providers: { apns: scriptedProvider('apns', ['retry']) } }).d.process({
        userId: USER,
        payload: { ...notification() },
      });
    for (let i = 0; i < 4; i += 1) expect(await run()).toMatchObject({ failed: 1 });
    expect(await run()).toMatchObject({ gone: 1 });
    expect(registry.live.size).toBe(0);
  });

  it('does not count a permanent failure (bad credentials) against the subscription', async () => {
    const registry = memoryRegistry([target(1)]);
    const apns = scriptedProvider('apns', ['failed']);
    const { d, waits } = delivery({ registry, providers: { apns } });
    expect(await d.process({ userId: USER, payload: { ...notification() } })).toMatchObject({
      failed: 1,
    });
    expect(waits).toEqual([]);
    expect(registry.calls.failure).toEqual([]);
    expect(registry.live.size).toBe(1);
  });

  it('logs the subscription id and provider only, never the endpoint, keys or payload', async () => {
    const lines: string[] = [];
    const log = (level: string) => (obj: unknown, msg: string) =>
      lines.push(`${level} ${msg} ${JSON.stringify(obj)}`);
    const logger = {
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      debug: log('debug'),
    };
    const targets = [webTarget().target, webTarget().target, webTarget().target];
    for (const [i, result] of (['retry', 'gone', 'failed'] as const).entries()) {
      const one = targets[i];
      if (one === undefined) continue;
      await delivery({
        registry: memoryRegistry([one]),
        providers: { web_push: scriptedProvider('web_push', [result]) },
        logger: logger as never,
      }).d.process({ userId: USER, payload: { ...notification() } });
    }
    const text = lines.join('\n');
    for (const event of ['push.send_failed', 'push.subscription_gone', 'push.send_refused'])
      expect(text).toContain(event);
    for (const t of targets) {
      expect(text).toContain(t.id);
      for (const secret of [t.token, t.keys?.p256dh ?? '', t.keys?.auth ?? ''])
        expect(text).not.toContain(secret);
    }
    for (const value of ['approval_needed', 'agt_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 'centcom://'])
      expect(text).not.toContain(value);
  });

  it('skips subscriptions of a provider that is not configured, keeping them', async () => {
    const registry = memoryRegistry([target(1, 'fcm')]);
    const { d } = delivery({ registry, providers: {} });
    expect(await d.process({ userId: USER, payload: { ...notification() } })).toMatchObject({
      skipped: 1,
    });
    expect(registry.live.size).toBe(1);
  });

  it('opens the circuit after 10 failures in a row and defers, then closes 60 s later', async () => {
    const registry = memoryRegistry(Array.from({ length: 4 }, (_, i) => target(i + 1)));
    const apns = scriptedProvider('apns', ['retry']);
    const { d, advance } = delivery({ registry, providers: { apns } });
    const report = await d.process({ userId: USER, payload: { ...notification() } });
    // Retries run in parallel per subscription; once 10 failures accumulate the rest defer.
    expect(apns.sent.length).toBeLessThanOrEqual(CIRCUIT_THRESHOLD + 3);
    expect(report.deferred?.subscriptionIds.length).toBeGreaterThan(0);
    expect(report.deferred?.delayMs).toBeGreaterThan(0);
    expect(report.deferred?.delayMs).toBeLessThanOrEqual(CIRCUIT_OPEN_MS);
    const before = apns.sent.length;
    const again = await d.process({
      userId: USER,
      payload: { ...notification() },
      subscriptionIds: report.deferred?.subscriptionIds ?? [],
    });
    expect(apns.sent.length).toBe(before);
    expect(again.deferred?.subscriptionIds).toEqual(report.deferred?.subscriptionIds);
    advance(CIRCUIT_OPEN_MS);
    const ok = memoryRegistry([target(9)]);
    const healthy = scriptedProvider('apns', ['sent']);
    const later = new PushDelivery({ registry: ok, providers: { apns: healthy }, concurrency: 20 });
    expect(await later.process({ userId: USER, payload: { ...notification() } })).toMatchObject({
      sent: 1,
    });
    expect(d.breakers.apns.openFor()).toBe(0);
  });

  it('keeps every provider within its concurrency for 1 000 pushes through 10 concurrent jobs', async () => {
    const targets = [target(1, 'apns'), target(2, 'apns'), target(3, 'fcm'), target(4, 'web_push')];
    const registry = memoryRegistry(targets);
    const providers = {
      apns: scriptedProvider('apns', ['sent'], 1),
      fcm: scriptedProvider('fcm', ['sent'], 1),
      web_push: scriptedProvider('web_push', ['sent'], 1),
    };
    const d = new PushDelivery({ registry, providers, concurrency: 20 });
    let next = 0;
    let sent = 0;
    const worker = async (): Promise<void> => {
      while (next < 1000) {
        next += 1;
        const report = await d.process({ userId: USER, payload: { ...notification() } });
        sent += report.sent;
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));
    expect(sent).toBe(4000);
    for (const p of Object.values(providers)) expect(p.peak()).toBeLessThanOrEqual(20);
    expect(d.semaphores.apns.peak).toBeLessThanOrEqual(20);
    expect(d.semaphores.apns.peak).toBeGreaterThan(1);
  }, 60_000);

  it('completes as a no-op when the subscription is gone', async () => {
    const { d } = delivery({
      registry: memoryRegistry([]),
      providers: { apns: scriptedProvider('apns') },
    });
    expect(await d.process({ userId: USER, payload: { ...notification() } })).toEqual({
      sent: 0,
      gone: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('PushSender', () => {
  it('queues one notify.push job per notification and user', async () => {
    const added: { name: string; data: unknown; opts: { jobId: string } }[] = [];
    const sender = new PushSender({
      add: (name, data, opts) => {
        added.push({ name, data, opts });
        return Promise.resolve();
      },
    });
    await sender.enqueue(USER, notification());
    expect(added).toEqual([
      {
        name: NOTIFY_PUSH_QUEUE,
        data: { userId: USER, payload: notification() },
        opts: expect.objectContaining({ jobId: `push-${notification().id}-${USER}`, attempts: 1 }),
      },
    ]);
    expect(added[0]?.opts.jobId).not.toContain(':');
  });
});
