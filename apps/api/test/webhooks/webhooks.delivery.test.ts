/**
 * Delivery (B081 acceptance 1, 2, 3 and 5, guardrails), against a real HTTP receiver on loopback:
 * - a 2xx ends the delivery `delivered` (the API's `succeeded`); a non-2xx, a timeout or a refused
 *   connection schedules the next attempt after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h and 24 h (±10 %),
 *   and the 7th retry's failure ends it `failed`;
 * - `Centcom-Signature` verifies as HMAC_SHA256(secret, t.raw_body) over the exact bytes received;
 *   during a rotation's 24 h overlap it carries two `v1`, both verifying, and 24 h + 1 s after only
 *   the new;
 * - the body's `id`, `Centcom-Event-Id` and the delivery id are one on every retry, while
 *   `Centcom-Delivery-Attempt` counts 1, 2, 3 …;
 * - 301/302 are not followed and count as failures;
 * - a secret that cannot be opened sends nothing (no unsigned send) and counts
 *   `webhook_secret_unavailable_total`;
 * - at most 5 attempts in flight per endpoint; at most 64 KiB read and 1 KiB kept.
 */
import { verifySignature, WEBHOOK_API_VERSION, type WebhookEvent } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_TIMEOUT_MS } from '../../src/modules/webhooks/http.js';
import {
  KeyedLimiter,
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_MS,
  SECRET_OVERLAP_MS,
  WebhookService,
} from '../../src/modules/webhooks/service.js';
import { recordingMetrics } from '../helpers.js';
import { quickSender, receiver, recordingCtx, testConfig, webhookService } from './helpers.js';
import { newId } from '@centcom/contracts';

const WS = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

function event(type: WebhookEvent['type'] = 'session.member.joined'): WebhookEvent {
  return {
    id: crypto.randomUUID(),
    type,
    workspace: WS,
    data: { session: newId('ses'), member: newId('mem') },
    created_at: '2026-10-08T12:00:00.000Z',
  };
}

async function setup(
  script: Parameters<typeof receiver>[0],
  overrides: Parameters<typeof webhookService>[0] = {},
) {
  const r = await receiver(script);
  const t = webhookService(overrides);
  const { ctx } = recordingCtx();
  const created = await t.service.create(WS, { url: r.url(), events: ['*'] }, ctx as never);
  return { ...t, r, created, ctx };
}

/** Runs the attempts the worker would, moving the clock by each delay; returns the delays. */
async function runAll(
  service: WebhookService,
  clock: { advance(ms: number): void },
  deliveryId: string,
) {
  const delays: number[] = [];
  let next: { attempt: number; delayMs: number } | null = { attempt: 1, delayMs: 0 };
  while (next !== null) {
    clock.advance(next.delayMs);
    const result = await service.attempt(deliveryId, next.attempt);
    next = result.next;
    if (next !== null) delays.push(next.delayMs);
  }
  return delays;
}

describe('delivery attempts', () => {
  it('ends delivered on a 2xx, with the body, headers and signature of the contract', async () => {
    const t = await setup(() => ({ status: 204 }));
    await t.service.fanOut(event());
    const [job] = t.queue.jobs;
    expect(job?.opts.jobId).toBe(`${job?.data.deliveryId}-1`);
    const result = await t.service.attempt(job?.data.deliveryId ?? '', 1);
    expect(result).toEqual({ next: null, final: 'delivered' });
    const [got] = t.r.received;
    const body = JSON.parse(got?.body.toString() ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      id: job?.data.deliveryId,
      type: 'session.member.joined',
      workspace: WS,
      api_version: WEBHOOK_API_VERSION,
    });
    expect(got?.headers['centcom-event-id']).toBe(job?.data.deliveryId);
    expect(got?.headers['centcom-event-type']).toBe('session.member.joined');
    expect(got?.headers['centcom-delivery-attempt']).toBe('1');
    expect(got?.headers['content-type']).toBe('application/json');
    expect(got?.headers['cookie']).toBeUndefined();
    expect(got?.headers['authorization']).toBeUndefined();
    const now = Math.floor(t.clock.now / 1000);
    expect(
      verifySignature(
        String(got?.headers['centcom-signature']),
        got?.body ?? Buffer.alloc(0),
        t.created.secret,
        now,
      ),
    ).toBe(true);
    const log = await t.service.deliveries(await t.service.find(t.created.id), {
      limit: 10,
      sort: 'created',
      filterHash: 'x',
      keys: [],
      now: t.clock.now,
    } as never);
    expect(log.data[0]).toMatchObject({ status: 'succeeded', attempt: 1, response_status: 204 });
    expect(t.repository.deliveries.get(job?.data.deliveryId ?? '')?.status).toBe('delivered');
    await t.r.close();
  });

  it('retries a failure on the schedule (±10 %) and ends failed after the 7th retry, one id throughout', async () => {
    const t = await setup(() => ({ status: 500 }));
    await t.service.fanOut(event());
    const id = t.queue.jobs[0]?.data.deliveryId ?? '';
    const delays = await runAll(t.service, t.clock, id);
    expect(delays).toEqual(RETRY_SCHEDULE_MS.map((d) => Math.round(d * (0.9 + 0.2 * 0.5))));
    expect(t.r.received).toHaveLength(MAX_ATTEMPTS);
    expect(t.r.received.map((r) => r.headers['centcom-delivery-attempt'])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
    const ids = new Set(
      t.r.received.flatMap((r) => [
        r.headers['centcom-event-id'],
        (JSON.parse(r.body.toString()) as { id: string }).id,
      ]),
    );
    expect([...ids]).toEqual([id]);
    expect(t.repository.deliveries.get(id)).toMatchObject({
      status: 'failed',
      attempt: 8,
      httpStatus: 500,
      lastError: 'http_status',
    });
    expect(t.repository.endpoints.get(t.created.id)?.status).toBe('failing');
    await t.r.close();
  });

  it('keeps retry delays within ±10 % of the schedule', () => {
    for (const random of [0, 0.25, 0.999999]) {
      const { service } = webhookService({ random: () => random });
      RETRY_SCHEDULE_MS.forEach((base, i) => {
        const d = service.retryDelay(i + 1);
        expect(d).toBeGreaterThanOrEqual(Math.floor(base * 0.9));
        expect(d).toBeLessThanOrEqual(Math.ceil(base * 1.1));
      });
    }
  });

  it('counts a timeout and a refused connection as failures, retried', async () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
    const slow = await setup(() => ({ status: 200, delayMs: 500 }), { sender: quickSender(100) });
    await slow.service.fanOut(event());
    const result = await slow.service.attempt(slow.queue.jobs[0]?.data.deliveryId ?? '', 1);
    expect(result.next?.attempt).toBe(2);
    expect(
      slow.repository.deliveries.get(slow.queue.jobs[0]?.data.deliveryId ?? '')?.lastError,
    ).toBe('timeout');
    await slow.r.close();

    const t = webhookService();
    const { ctx } = recordingCtx();
    const gone = await receiver();
    const url = gone.url();
    await gone.close();
    await t.service.create(WS, { url, events: ['*'] }, ctx as never);
    await t.service.fanOut(event());
    const refused = await t.service.attempt(t.queue.jobs[0]?.data.deliveryId ?? '', 1);
    expect(refused.next?.attempt).toBe(2);
    expect([...t.repository.deliveries.values()][0]?.lastError).toBe('connection');
  });

  it('does not follow 301/302, counting them as failures', async () => {
    for (const status of [301, 302]) {
      const t = await setup(() => ({
        status,
        headers: { location: 'http://127.0.0.1:1/elsewhere' },
      }));
      await t.service.fanOut(event());
      const id = t.queue.jobs[0]?.data.deliveryId ?? '';
      const result = await t.service.attempt(id, 1);
      expect(result.next?.attempt).toBe(2);
      expect(t.r.received).toHaveLength(1);
      expect(t.repository.deliveries.get(id)).toMatchObject({
        httpStatus: status,
        lastError: 'redirect',
      });
      await t.r.close();
    }
  });

  it('signs with both secrets during a rotation overlap, and only the new one 24 h + 1 s after', async () => {
    const t = await setup(() => ({ status: 200 }));
    const old = t.created.secret;
    const endpoint = await t.service.find(t.created.id);
    const rotated = await t.service.update(endpoint, { rotate_secret: true }, t.ctx as never);
    const fresh = rotated.secret ?? '';
    expect(fresh).not.toBe(old);
    expect(rotated.secret_overlap_until).toBe(
      new Date(t.clock.now + SECRET_OVERLAP_MS).toISOString(),
    );
    const send = async () => {
      await t.service.fanOut(event());
      const job = t.queue.jobs.at(-1);
      await t.service.attempt(job?.data.deliveryId ?? '', 1);
      return t.r.received.at(-1);
    };
    const during = await send();
    const header = String(during?.headers['centcom-signature']);
    expect(header.match(/v1=/g)).toHaveLength(2);
    const now = () => Math.floor(t.clock.now / 1000);
    expect(verifySignature(header, during?.body ?? Buffer.alloc(0), fresh, now())).toBe(true);
    expect(verifySignature(header, during?.body ?? Buffer.alloc(0), old, now())).toBe(true);
    t.clock.advance(SECRET_OVERLAP_MS + 1000);
    const after = await send();
    const header2 = String(after?.headers['centcom-signature']);
    expect(header2.match(/v1=/g)).toHaveLength(1);
    expect(verifySignature(header2, after?.body ?? Buffer.alloc(0), fresh, now())).toBe(true);
    expect(verifySignature(header2, after?.body ?? Buffer.alloc(0), old, now())).toBe(false);
    await t.r.close();
  });

  it('sends nothing unsigned when the secret cannot be opened, and counts it', async () => {
    const recorded = recordingMetrics();
    const t = await setup(() => ({ status: 200 }), { metrics: recorded.metrics });
    await t.service.fanOut(event());
    const id = t.queue.jobs[0]?.data.deliveryId ?? '';
    // A different key: the sealed secret no longer opens.
    const broken = new WebhookService({
      repository: t.repository,
      config: testConfig(),
      queue: t.queue,
      clock: t.clock.read,
      metrics: recorded.metrics,
    });
    const result = await broken.attempt(id, 1);
    expect(result).toEqual({ next: { attempt: 1, delayMs: 60_000 }, final: null });
    expect(t.r.received).toHaveLength(0);
    expect(t.repository.deliveries.get(id)?.attempt).toBe(0);
    expect(recorded.count('webhook_secret_unavailable_total')).toBe(1);
    await t.r.close();
  });

  it('keeps at most 1 KiB of the answer, without control characters, reading at most 64 KiB', async () => {
    const t = await setup(() => ({ status: 500, body: `bad\u0007\r\n${'x'.repeat(200_000)}` }));
    await t.service.fanOut(event());
    const id = t.queue.jobs[0]?.data.deliveryId ?? '';
    await t.service.attempt(id, 1);
    const excerpt = t.repository.deliveries.get(id)?.responseExcerpt ?? '';
    expect(excerpt.length).toBe(1024);
    expect(excerpt.startsWith('badx')).toBe(true);
    await t.r.close();
  });

  it('runs at most 5 attempts at once per endpoint', async () => {
    const t = await setup(() => ({ status: 200, delayMs: 50 }));
    for (let i = 0; i < 12; i += 1) await t.service.fanOut(event());
    await Promise.all(t.queue.jobs.map((j) => t.service.attempt(j.data.deliveryId, 1)));
    expect(t.r.received).toHaveLength(12);
    expect(t.r.peak()).toBe(5);
    const limiter = new KeyedLimiter(20);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 50 }, () =>
        limiter.run('wsp', async () => {
          peak = Math.max(peak, limiter.active('wsp'));
          await new Promise((r) => setTimeout(r, 2));
        }),
      ),
    );
    expect(peak).toBe(20);
    await t.r.close();
  });
});
