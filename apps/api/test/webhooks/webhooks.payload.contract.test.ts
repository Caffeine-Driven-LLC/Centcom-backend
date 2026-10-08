/**
 * Payloads against CT-WEBHOOKS (B081 acceptance 8, guardrail "no content in a payload", failure
 * mode "Redis outage"): for every event type, a `data` holding its CT-WEBHOOKS fields passes and the
 * delivered body validates against `webhook.schema.json`; any other field (content, a path, a branch
 * name, a key) or a value of the wrong kind is refused before it is queued. The emitter queues on
 * `webhook.events` with the event id as job id and, with Redis down, writes the outbox instead
 * (nothing lost); the fixture `member_joined.json` matches the vocabulary.
 */
import { readFileSync } from 'node:fs';
import { newId, validate } from '@centcom/contracts';
import {
  createWebhookEventEmitter,
  InvalidWebhookEventError,
  WEBHOOK_DATA_FIELDS,
  WEBHOOK_EVENT_TYPES,
  webhookDataProblems,
  type WebhookEvent,
  type WebhookEventType,
} from '@centcom/core';
import { describe, expect, it } from 'vitest';
import type { WebhookSender } from '../../src/modules/webhooks/http.js';
import { MemoryWebhookRepository, recordingCtx, tableResolver, webhookService } from './helpers.js';

const WS = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

/** A valid `data` of each type: ids, enums, counts and names. */
function sample(type: WebhookEventType): Record<string, unknown> {
  const values: Record<string, unknown> = {
    member: newId('mem'),
    user: newId('usr'),
    role: 'member',
    invite: newId('inv'),
    email: 'new@example.test',
    session: newId('ses'),
    host: newId('mem'),
    name: 'Pairing on the API',
    state: 'live',
    agent: newId('agt'),
    outcome: 'success',
    minutes: 12,
    plan: 'team',
    status: 'active',
    seats: 7,
    invoice: 'in_1Abc',
    amount: 2900,
    currency: 'EUR',
    limit: 'hosted_minutes_month',
    pct: 80,
    key: newId('key'),
    scopes: ['sessions:read'],
    endpoint: newId('whk'),
  };
  return Object.fromEntries(Object.keys(WEBHOOK_DATA_FIELDS[type]).map((f) => [f, values[f]]));
}

describe('webhook payloads', () => {
  it.each(WEBHOOK_EVENT_TYPES)(
    '%s: its fields pass, and the delivered body validates',
    async (type) => {
      const data = sample(type);
      expect(webhookDataProblems(type, data)).toEqual([]);
      let body = '';
      const sender: WebhookSender = (req) => {
        body = req.body;
        return Promise.resolve({ ok: true, status: 200, durationMs: 1, excerpt: '' });
      };
      const t = webhookService({
        resolve: tableResolver({ 'hooks.example.com': ['93.184.216.34'] }),
        sender,
      });
      const { ctx } = recordingCtx();
      await t.service.create(
        WS,
        { url: 'https://hooks.example.com/in', events: ['*'] },
        ctx as never,
      );
      const event: WebhookEvent = {
        id: crypto.randomUUID(),
        type,
        workspace: WS,
        data,
        created_at: new Date().toISOString(),
      };
      await t.service.fanOut(event);
      const job = t.queue.jobs[0];
      if (job !== undefined) await t.service.attempt(job.data.deliveryId, 1);
      if (type === 'webhook.test') return; // sent only to the endpoint tested
      const payload = JSON.parse(body) as Record<string, unknown>;
      expect(validate('webhook', payload).ok).toBe(true);
      expect(Object.keys(payload).sort()).toEqual([
        'api_version',
        'created_at',
        'data',
        'id',
        'type',
        'workspace',
      ]);
      expect(Object.keys(payload['data'] as object).sort()).toEqual(Object.keys(data).sort());
    },
  );

  it.each(WEBHOOK_EVENT_TYPES)('%s: content, paths, branch names and keys are refused', (type) => {
    for (const extra of [
      { content: 'please deploy' },
      { path: '/home/dev/repo/src/main.ts' },
      { branch: 'feature/secret-plan' },
      { api_key: 'cen_live_' + 'x'.repeat(32) },
      { diff: '@@ -1 +1 @@' },
    ]) {
      expect(webhookDataProblems(type, { ...sample(type), ...extra })).toEqual(Object.keys(extra));
    }
    const fields = Object.keys(WEBHOOK_DATA_FIELDS[type]);
    const first = fields[0] ?? '';
    expect(webhookDataProblems(type, { ...sample(type), [first]: '../../etc/passwd' })).toEqual([
      first,
    ]);
  });

  it('matches the contract fixtures: member_joined is allowed, a content event type is not', () => {
    const read = (name: string) =>
      JSON.parse(
        readFileSync(
          new URL(`../../../../contracts/fixtures/webhook/${name}`, import.meta.url),
          'utf8',
        ),
      ) as { valid: boolean; data: { type: string; data: Record<string, unknown> } };
    const joined = read('member_joined.json');
    expect(joined.valid).toBe(true);
    expect(WEBHOOK_EVENT_TYPES).toContain(joined.data.type);
    expect(webhookDataProblems(joined.data.type as WebhookEventType, joined.data.data)).toEqual([]);
    const unknown = read('unknown_type.json');
    expect(unknown.valid).toBe(false);
    expect(WEBHOOK_EVENT_TYPES).not.toContain(unknown.data.type);
  });
});

describe('emitWebhookEvent', () => {
  it('queues the event under its id, refusing anything outside CT-WEBHOOKS', async () => {
    const added: { data: WebhookEvent; opts: { jobId: string } }[] = [];
    const emit = createWebhookEventEmitter({
      queue: { add: (_name, data, opts) => Promise.resolve(void added.push({ data, opts })) },
    });
    const event = await emit({
      type: 'usage.threshold',
      workspace: WS,
      data: { limit: 'hosted_minutes_month', pct: 80 },
    });
    expect(added).toEqual([{ data: event, opts: { jobId: event.id } }]);
    await expect(
      emit({ type: 'usage.threshold', workspace: WS, data: { limit: 'x', pct: 80, note: 'hi' } }),
    ).rejects.toBeInstanceOf(InvalidWebhookEventError);
    await expect(emit({ type: 'nope' as never, workspace: WS, data: {} })).rejects.toBeInstanceOf(
      InvalidWebhookEventError,
    );
    await expect(
      emit({ type: 'usage.threshold', workspace: 'wsp_x', data: {} }),
    ).rejects.toBeInstanceOf(InvalidWebhookEventError);
  });

  it('writes the outbox when Redis is down, and loses nothing', async () => {
    const outbox = new MemoryWebhookRepository();
    let down = true;
    const queued: WebhookEvent[] = [];
    const emit = createWebhookEventEmitter({
      queue: {
        add: (_n, data) =>
          down ? Promise.reject(new Error('redis down')) : Promise.resolve(void queued.push(data)),
      },
      outbox: { write: (e) => outbox.writeOutbox(e as unknown as Record<string, unknown>) },
    });
    const a = await emit({
      type: 'usage.threshold',
      workspace: WS,
      data: { limit: 'hosted_minutes_month', pct: 100 },
    });
    expect(queued).toEqual([]);
    expect(outbox.outbox).toEqual([a]);
    down = false;
    const moved = await outbox.drainOutbox(500, async (events) => {
      for (const e of events) queued.push(e as unknown as WebhookEvent);
    });
    expect(moved).toBe(1);
    expect(queued).toEqual([a]);
    expect(outbox.outbox).toEqual([]);
    await expect(
      createWebhookEventEmitter({ queue: { add: () => Promise.reject(new Error('redis down')) } })({
        type: 'usage.threshold',
        workspace: WS,
        data: { limit: 'hosted_minutes_month', pct: 80 },
      }),
    ).rejects.toThrow('redis down');
  });

  it('fans an event out once per event id', async () => {
    const t = webhookService({
      resolve: tableResolver({ 'hooks.example.com': ['93.184.216.34'] }),
    });
    const { ctx } = recordingCtx();
    await t.service.create(
      WS,
      { url: 'https://hooks.example.com/a', events: ['usage.threshold'] },
      ctx as never,
    );
    await t.service.create(
      WS,
      { url: 'https://hooks.example.com/b', events: ['session.created'] },
      ctx as never,
    );
    const event: WebhookEvent = {
      id: crypto.randomUUID(),
      type: 'usage.threshold',
      workspace: WS,
      data: { limit: 'hosted_minutes_month', pct: 80 },
      created_at: new Date().toISOString(),
    };
    expect(await t.service.fanOut(event)).toBe(1);
    expect(await t.service.fanOut(event)).toBe(0);
    expect(t.queue.jobs).toHaveLength(1);
  });
});
