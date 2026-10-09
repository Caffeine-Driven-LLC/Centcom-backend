/**
 * Privacy of webhooks (B072; tests "webhook.privacy.test.ts", acceptance 9): no log line or stored
 * column holds card data, the signature header or the webhook secret.
 *
 * - `reduceObject` keeps ids, status, amounts and currency only: no card, e-mail address, name or
 *   address, even nested or expanded;
 * - the stored rows (event payloads, outbox rows) of a full delivery-and-processing run, and every
 *   log line of it, contain none of them; neither do rejected deliveries' log lines;
 * - on Postgres (DATABASE_URL): `stripe_event` and `billing_outbox` have exactly their columns, and
 *   the stores keep the rules (unique ids, single claim, outbox uniqueness).
 */
import type { StripeEventsDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  createOutboxStore,
  createStripeEventStore,
  publishOutbox,
  reduceObject,
} from '../../../src/modules/billing/webhooks/index.js';
import { ADMIN_URL, migratedDatabase } from '../../modules/users/helpers.js';
import {
  eventBody,
  invoiceObject,
  MemoryOutbox,
  sign,
  stripeId,
  webhookHarness,
  webhookSecret,
} from './helpers.js';

const FORBIDDEN = [
  '4242',
  'exp_year',
  'billing@example.test',
  'Ada Lovelace',
  'Main St',
  'Berlin',
  'whsec_',
  'v1=',
];

describe('reduceObject', () => {
  it('keeps ids, status, amounts and currency, nothing else', () => {
    const object = {
      object: 'invoice',
      id: 'in_123',
      customer: { id: 'cus_abc', email: 'x@example.test' },
      subscription: 'sub_xyz',
      status: 'open',
      currency: 'eur',
      amount_due: 4900,
      amount_paid: -1,
      customer_email: 'x@example.test',
      payment_intent: { payment_method: { card: { last4: '4242' } } },
      description: 'Card ending 4242',
    };
    expect(reduceObject(object)).toEqual({
      object: 'invoice',
      id: 'in_123',
      customer: 'cus_abc',
      subscription: 'sub_xyz',
      status: 'open',
      currency: 'eur',
      amount_due: 4900,
    });
    expect(reduceObject(null)).toEqual({});
    expect(reduceObject([1, 2])).toEqual({});
    expect(reduceObject({ id: 'not an id!', currency: 'EURO' })).toEqual({});
  });
});

describe('no card data, signature or secret in rows and logs (acceptance 9)', () => {
  it('holds for a full run, rejections included', async () => {
    const h = await webhookHarness();
    const { sub } = h.customer({ plan: 'team' });
    h.stripe.subs.set(sub.id, { ...sub, status: 'past_due' });
    const failed = eventBody('invoice.payment_failed', invoiceObject(sub));
    const signature = sign(failed.body, h.secrets[0] ?? '', Math.floor(h.clock.now / 1000));
    await h.deliver(failed.body, { signature });
    await h.deliver(failed.body, { secret: webhookSecret('Q') });
    await h.deliver(eventBody('invoice.paid', invoiceObject(sub)).body);
    await h.drain();
    const rows = JSON.stringify([...h.events.rows.values()]) + JSON.stringify(h.outbox.rows);
    const logs = h.captured.raw();
    for (const needle of [...FORBIDDEN, signature, h.secrets[0] ?? 'x']) {
      expect(rows, needle).not.toContain(needle);
      expect(logs, needle).not.toContain(needle);
    }
    expect(logs).toContain('stripe_webhook.rejected');
    await h.app.close();
  });
});

describe('publishOutbox', () => {
  it('stops at a failing row and resumes from it on the next run', async () => {
    const outbox = new MemoryOutbox();
    const workspaceId = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
    await outbox.add({
      type: 'billing.invoice.paid',
      workspaceId,
      payload: { invoice: 'in_1', amount: 1, currency: 'EUR' },
      dedupeKey: 'in_1',
    });
    await outbox.add({
      type: 'notify.billing_issue',
      workspaceId,
      payload: { kind: 'payment_failed' },
      dedupeKey: 'in_2',
    });
    expect(
      await outbox.add({
        type: 'notify.billing_issue',
        workspaceId,
        payload: {},
        dedupeKey: 'in_2',
      }),
    ).toBe(false);
    let fail = true;
    const sent: string[] = [];
    const deps = {
      outbox,
      emitWebhook: (input: { type: string }) => {
        if (fail) return Promise.reject(new Error('redis down'));
        sent.push(input.type);
        return Promise.resolve();
      },
      notify: { publish: () => (sent.push('notify'), Promise.resolve('ntf')) },
    };
    expect(await publishOutbox(deps as never)).toBe(0);
    expect(sent).toEqual([]);
    fail = false;
    expect(await publishOutbox(deps as never)).toBe(2);
    expect(sent).toEqual(['billing.invoice.paid', 'notify']);
    expect(await publishOutbox(deps as never)).toBe(0);
  });
});

describe.runIf(ADMIN_URL !== undefined)('the webhook tables on Postgres 16', () => {
  it('have exactly their columns, and the stores keep their rules', async () => {
    const test = await migratedDatabase(4);
    try {
      const db = test.db as unknown as Kysely<StripeEventsDatabase>;
      const columns = async (table: string) =>
        (
          await sql<{ c: string }>`select column_name as c from information_schema.columns
            where table_schema = 'public' and table_name = ${table} order by 1`.execute(db)
        ).rows.map((r) => r.c);
      expect(await columns('stripe_event')).toEqual([
        'attempts',
        'created_at_stripe',
        'event_id',
        'last_error',
        'payload',
        'processed_at',
        'received_at',
        'status',
        'type',
      ]);
      expect(await columns('billing_outbox')).toEqual([
        'created_at',
        'dedupe_key',
        'id',
        'payload',
        'published_at',
        'type',
        'workspace_id',
      ]);

      const events = createStripeEventStore(db);
      const id = stripeId('evt');
      const event = {
        eventId: id,
        type: 'invoice.paid',
        created: 1_700_000_000,
        object: { id: 'in_1' },
        status: 'received' as const,
      };
      const inserts = await Promise.all(Array.from({ length: 5 }, () => events.insert(event)));
      expect(inserts.filter(Boolean)).toHaveLength(1);
      const claims = await Promise.all([events.claim(id), events.claim(id)]);
      expect(claims.every((c) => c !== null)).toBe(true);
      await events.finish(id, 'processed');
      expect(await events.claim(id)).toBeNull();
      expect((await events.claim(id, { force: true }))?.attempts).toBe(3);
      await events.release(id, 'stripe_unavailable');
      expect(await events.get(id)).toMatchObject({
        status: 'processing',
        lastError: 'stripe_unavailable',
        created: 1_700_000_000,
        object: { id: 'in_1' },
      });
      expect(await events.waiting(new Date(Date.now() + 1_000), 10)).toEqual([id]);
      expect(await events.oldestWaiting()).toBeInstanceOf(Date);
      await events.finish(id, 'failed', 'unknown_customer');
      expect(await events.waiting(new Date(Date.now() + 1_000), 10)).toEqual([]);
      expect(await events.oldestWaiting()).toBeNull();
      expect(await events.get('evt_none')).toBeNull();
      await events.insert({ ...event, eventId: stripeId('evt'), status: 'ignored' });

      const outbox = createOutboxStore(db);
      const workspaceId = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
      const entry = {
        type: 'billing.invoice.paid' as const,
        workspaceId,
        payload: { invoice: 'in_1', amount: 1, currency: 'EUR' },
        dedupeKey: 'in_1',
      };
      expect(await outbox.add(entry)).toBe(true);
      expect(await outbox.add(entry)).toBe(false);
      const pending = await outbox.pending(10);
      expect(pending).toEqual([{ ...entry, id: expect.any(String) }]);
      await outbox.markPublished(pending[0]?.id ?? '');
      expect(await outbox.pending(10)).toEqual([]);
    } finally {
      await test.drop();
    }
  });
});
