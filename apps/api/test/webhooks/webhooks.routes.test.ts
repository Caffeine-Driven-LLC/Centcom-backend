/**
 * CT-API-WEBHOOKS over HTTP (B081 acceptance 7 and 9, guardrails), on the workspace routes' plugin
 * stack (auth, RBAC, audit, idempotency):
 * - create needs `Idempotency-Key` (400 `idempotency_key_required` without), answers 201 with the
 *   secret once, and a replay answers the same response, never a second secret; GET and list never
 *   show it;
 * - the (`webhooks_max` + 1)-th endpoint is 403 `entitlement_required`;
 * - owners and admins manage; members 403; outsiders 404; API keys need `webhooks:write`;
 * - PATCH rotates the secret (shown once) and validates its fields; DELETE is 204;
 * - `test` answers 202 with the attempt's result well within 15 s; `redeliver` queues an attempt
 *   at once (202) and the delivery log shows it;
 * - responses validate against the contract's schemas; create, update and delete are audited.
 */
import { randomUUID } from 'node:crypto';
import { validate } from '@centcom/contracts';
import type { WorkspaceRole } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { WebhookService } from '../../src/modules/webhooks/service.js';
import { webhookRoutes } from '../../src/routes/webhooks.js';
import { asKey, asUser, createWorkspace, workspacesApp } from '../modules/workspaces/helpers.js';
import {
  KEYS,
  MemoryWebhookRepository,
  receiver,
  recordingQueue,
  tableResolver,
  testConfig,
} from './helpers.js';
import { newId } from '@centcom/contracts';

const SCOPES = 'workspaces:read workspaces:write webhooks:write';

async function app(webhooksMax: number | null = 5) {
  const repository = new MemoryWebhookRepository();
  const queue = recordingQueue();
  const service = new WebhookService({
    repository,
    config: testConfig(true),
    queue,
    limits: { get: () => Promise.resolve({ limits: { webhooks_max: webhooksMax } }) },
    resolve: tableResolver({ 'hooks.example.com': ['93.184.216.34'] }),
  });
  const base = await workspacesApp({
    beforeReady: async (instance) => {
      await instance.register(webhookRoutes, { service, cursorKeys: KEYS });
    },
  });
  const owner = newId('usr');
  base.store.addUser(owner);
  const ws = (await createWorkspace(base.app, owner)).id;
  const create = (body: unknown, key: string | null = randomUUID(), user = owner) =>
    base.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}/webhooks`,
      headers: { ...asUser(user, SCOPES), ...(key === null ? {} : { 'idempotency-key': key }) },
      payload: body as Record<string, unknown>,
    });
  /** The actions audited in transactions. */
  const audited = () =>
    repository.auditParameters
      .flat()
      .filter((p) => typeof p === 'string' && p.startsWith('webhook.'));
  return { ...base, service, repository, queue, owner, ws, create, audited };
}

describe('webhook management', () => {
  it('creates with the secret once; a replay answers the same; GET and list never show it', async () => {
    const t = await app();
    const key = randomUUID();
    const url = 'https://hooks.example.com/in';
    const first = await t.create({ url, events: ['session.created', 'agent.completed'] }, key);
    expect(first.statusCode).toBe(201);
    const created = first.json<Record<string, unknown>>();
    expect(String(created['secret'])).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(validate('api/WebhookCreated', created).ok).toBe(true);
    const replay = await t.create({ url, events: ['session.created', 'agent.completed'] }, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(created);
    expect(t.repository.endpoints.size).toBe(1);

    const one = await t.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${String(created['id'])}`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(one.statusCode).toBe(200);
    expect(validate('api/Webhook', one.json()).ok).toBe(true);
    expect(one.body).not.toContain(String(created['secret']));
    expect(one.json()).not.toHaveProperty('secret');
    const list = await t.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${t.ws}/webhooks`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(validate('api/WebhookPage', list.json()).ok).toBe(true);
    expect(list.body).not.toContain('whsec_');
    expect(t.audited()).toContain('webhook.create');
    await t.app.close();
  });

  it('needs Idempotency-Key on create, and refuses the endpoint past webhooks_max', async () => {
    const t = await app(2);
    const r = await receiver();
    const none = await t.create({ url: r.url(), events: ['*'] }, null);
    expect(none.statusCode).toBe(400);
    expect(none.json<{ code: string }>().code).toBe('idempotency_key_required');
    expect((await t.create({ url: r.url('/1'), events: ['*'] })).statusCode).toBe(201);
    expect((await t.create({ url: r.url('/2'), events: ['*'] })).statusCode).toBe(201);
    const third = await t.create({ url: r.url('/3'), events: ['*'] });
    expect(third.statusCode).toBe(403);
    expect(third.json<{ code: string }>().code).toMatch(/^entitlement_/);
    await r.close();
    await t.app.close();
  });

  it('lets owners and admins manage, refuses members (403) and outsiders (404), and API keys without the scope', async () => {
    const t = await app();
    const r = await receiver();
    const created = (await t.create({ url: r.url(), events: ['*'] })).json<{ id: string }>();
    const get = (headers: Record<string, string>) =>
      t.app.inject({ method: 'GET', url: `/v1/webhooks/${created.id}`, headers });
    for (const [role, status] of [
      ['admin', 200],
      ['member', 403],
      ['billing', 403],
      ['guest', 403],
    ] as [WorkspaceRole, number][]) {
      const user = newId('usr');
      t.store.join(t.ws, user, role);
      expect((await get(asUser(user, SCOPES))).statusCode, role).toBe(status);
    }
    expect((await get(asUser(newId('usr'), SCOPES))).statusCode).toBe(404);
    expect((await get(asUser(t.owner, 'workspaces:read'))).statusCode).toBe(403);
    expect((await get(asKey(t.ws, 'webhooks:write'))).statusCode).toBe(200);
    expect((await get(asKey(t.ws, 'workspaces:read'))).statusCode).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/v1/webhooks/${newId('whk')}`,
          headers: asUser(t.owner, SCOPES),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await t.create({ url: 'http://example.com/in', events: ['*'] })).json<{ code: string }>()
        .code,
    ).toBe('webhook_url_invalid');
    expect((await t.create({ url: r.url(), events: ['message.sent'] })).statusCode).toBe(422);
    await r.close();
    await t.app.close();
  });

  it('rotates the secret on PATCH, validates fields, and deletes with 204', async () => {
    const t = await app();
    const r = await receiver();
    const created = (await t.create({ url: r.url(), events: ['*'] })).json<{
      id: string;
      secret: string;
    }>();
    const patch = (payload: unknown) =>
      t.app.inject({
        method: 'PATCH',
        url: `/v1/webhooks/${created.id}`,
        headers: asUser(t.owner, SCOPES),
        payload: payload as Record<string, unknown>,
      });
    const rotated = await patch({ rotate_secret: true });
    expect(rotated.statusCode).toBe(200);
    const body = rotated.json<{
      secret: string;
      secret_rotated_at: string;
      secret_overlap_until: string;
    }>();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.secret).not.toBe(created.secret);
    expect(body.secret_overlap_until).not.toBeNull();
    expect((await patch({ events: [] })).statusCode).toBe(422);
    expect((await patch({})).statusCode).toBe(422);
    expect((await patch({ enabled: false })).json<{ enabled: boolean }>().enabled).toBe(false);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/v1/webhooks/${created.id}`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(del.statusCode).toBe(204);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/v1/webhooks/${created.id}`,
          headers: asUser(t.owner, SCOPES),
        })
      ).statusCode,
    ).toBe(404);
    expect(t.audited()).toEqual(
      expect.arrayContaining(['webhook.create', 'webhook.update', 'webhook.delete']),
    );
    await r.close();
    await t.app.close();
  });

  it('answers test with the attempt result within 15 s, and redelivers at once into the log', async () => {
    const t = await app();
    let status = 200;
    const r = await receiver(() => ({ status }));
    const created = (await t.create({ url: r.url(), events: ['*'] })).json<{ id: string }>();
    const started = performance.now();
    const test = await t.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${created.id}/test`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(test.statusCode).toBe(202);
    const delivery = test.json<{
      id: string;
      status: string;
      attempt: number;
      response_status: number;
      event_type: string;
    }>();
    // `webhook.test` is outside the listed event types, which the contract marks extensible.
    expect(validate('api/WebhookDelivery', delivery, { mode: 'tolerant' }).ok).toBe(true);
    expect(delivery).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      response_status: 200,
      event_type: 'webhook.test',
    });
    expect(JSON.parse(r.received[0]?.body.toString() ?? '{}')).toMatchObject({
      type: 'webhook.test',
      data: { endpoint: created.id },
    });

    status = 500;
    const failed = await t.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${created.id}/test`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(failed.json()).toMatchObject({ status: 'failed', response_status: 500 });

    const queuedBefore = t.queue.jobs.length;
    const redeliverAt = performance.now();
    const again = await t.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${created.id}/deliveries/${delivery.id}/redeliver`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ id: delivery.id, status: 'pending' });
    const job = t.queue.jobs[queuedBefore];
    expect(job?.data).toEqual({ deliveryId: delivery.id, attempt: 2 });
    expect(job?.opts.delay).toBe(0);
    status = 200;
    await t.service.attempt(delivery.id, 2);
    expect(performance.now() - redeliverAt).toBeLessThan(5_000);
    const log = await t.app.inject({
      method: 'GET',
      url: `/v1/webhooks/${created.id}/deliveries`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(validate('api/WebhookDeliveryPage', log.json(), { mode: 'tolerant' }).ok).toBe(true);
    expect(log.json<{ data: { id: string; attempt: number; status: string }[] }>().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: delivery.id, attempt: 2, status: 'succeeded' }),
      ]),
    );
    const unknown = await t.app.inject({
      method: 'POST',
      url: `/v1/webhooks/${created.id}/deliveries/${newId('dlv')}/redeliver`,
      headers: asUser(t.owner, SCOPES),
    });
    expect(unknown.statusCode).toBe(404);
    await r.close();
    await t.app.close();
  });
});
