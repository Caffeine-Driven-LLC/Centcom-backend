/**
 * Endpoint health (B081 acceptance 6, failure mode "receiver down for days"): deliveries failing
 * keep the endpoint `failing`; after 3 consecutive days of failures without a success it becomes
 * `enabled: false`, `status: 'disabled'`, and the owners' e-mail and the audit event go out exactly
 * once; a success in between restarts the count; a disabled endpoint gets no new deliveries and its
 * pending ones end `failed` (`endpoint_disabled`); re-enabling makes it `active` again.
 */
import { newId } from '@centcom/contracts';
import type { WebhookEvent } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { WebhookSender } from '../../src/modules/webhooks/http.js';
import { DISABLE_AFTER_MS } from '../../src/modules/webhooks/service.js';
import { recordingCtx, tableResolver, webhookService } from './helpers.js';

const WS = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const HOUR = 60 * 60 * 1000;

function harness(ok: () => boolean) {
  const notices: string[] = [];
  const audits: unknown[] = [];
  const sender: WebhookSender = () =>
    Promise.resolve(
      ok()
        ? { ok: true, status: 200, durationMs: 1, excerpt: '' }
        : { ok: false, error: 'http_status', status: 503, durationMs: 1, excerpt: '' },
    );
  const t = webhookService({
    resolve: tableResolver({ 'hooks.example.com': ['93.184.216.34'] }),
    sender,
    notifier: { endpointDisabled: (_ws, id) => Promise.resolve(void notices.push(id)) },
    audit: { emitDetached: (e) => void audits.push(e) },
  });
  return { ...t, notices, audits };
}

const event = (): WebhookEvent => ({
  id: crypto.randomUUID(),
  type: 'session.member.joined',
  workspace: WS,
  data: { session: newId('ses'), member: newId('mem') },
  created_at: new Date().toISOString(),
});

/** One new delivery's first attempt. */
async function deliverOnce(t: ReturnType<typeof harness>) {
  await t.service.fanOut(event());
  const job = t.queue.jobs.at(-1);
  return job === undefined ? null : t.service.attempt(job.data.deliveryId, 1);
}

describe('endpoint health', () => {
  it('disables after 3 days of failures, with one e-mail and one audit event', async () => {
    let healthy = false;
    const t = harness(() => healthy);
    const { ctx } = recordingCtx();
    const created = await t.service.create(
      WS,
      { url: 'https://hooks.example.com/in', events: ['*'] },
      ctx as never,
    );
    await deliverOnce(t);
    expect(t.repository.endpoints.get(created.id)?.failingSince).not.toBeNull();
    for (let h = 0; h < 71; h += 1) {
      t.clock.advance(HOUR);
      await deliverOnce(t);
    }
    expect(t.repository.endpoints.get(created.id)).toMatchObject({ enabled: true });
    t.clock.advance(HOUR);
    await deliverOnce(t);
    expect(t.repository.endpoints.get(created.id)).toMatchObject({
      enabled: false,
      status: 'disabled',
    });
    expect(t.notices).toEqual([created.id]);
    expect(t.audits).toEqual([
      expect.objectContaining({
        workspaceId: WS,
        action: 'webhook.update',
        actor: { type: 'system', id: 'webhooks' },
        target: { type: 'webhook', id: created.id },
        meta: { fields: 'enabled status', enabled: false },
      }),
    ]);
    // Disabled: no new deliveries, and attempts already queued end failed, with no more notices.
    const before = t.queue.jobs.length;
    await t.service.fanOut(event());
    expect(t.queue.jobs.length).toBe(before);
    const queued = [...t.repository.deliveries.values()].find((d) => d.status === 'pending');
    if (queued !== undefined) {
      await t.service.attempt(queued.id, queued.attempt + 1);
      expect(t.repository.deliveries.get(queued.id)).toMatchObject({
        status: 'failed',
        lastError: 'endpoint_disabled',
      });
    }
    expect(t.notices).toHaveLength(1);
    expect(t.audits).toHaveLength(1);

    // Re-enabled: active again, the failure run forgotten.
    const endpoint = await t.service.find(created.id);
    healthy = true;
    const again = await t.service.update(endpoint, { enabled: true }, ctx as never);
    expect(again).toMatchObject({ enabled: true, status: 'active' });
    expect(t.repository.endpoints.get(created.id)?.failingSince).toBeNull();
  });

  it('restarts the count after a success', async () => {
    let calls = 0;
    const t = harness(() => {
      calls += 1;
      return calls === 30;
    });
    const { ctx } = recordingCtx();
    const created = await t.service.create(
      WS,
      { url: 'https://hooks.example.com/in', events: ['*'] },
      ctx as never,
    );
    for (let h = 0; h < 100; h += 1) {
      t.clock.advance(HOUR);
      await deliverOnce(t);
    }
    // The run restarted with the first failure after the success (hour 31): 69 hours, not 3 days.
    expect(t.repository.endpoints.get(created.id)?.enabled).toBe(true);
    t.clock.advance(DISABLE_AFTER_MS - 69 * HOUR - 1);
    await deliverOnce(t);
    expect(t.repository.endpoints.get(created.id)?.enabled).toBe(true);
    t.clock.advance(1);
    await deliverOnce(t);
    expect(t.repository.endpoints.get(created.id)?.enabled).toBe(false);
    expect(t.notices).toHaveLength(1);
  });
});
