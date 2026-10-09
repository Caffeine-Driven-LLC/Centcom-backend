/**
 * Webhook signatures (B072; tests "webhook.signature.test.ts"):
 *
 * - a wrong signature, a timestamp older than 300 s, or a modified body is 400 and stores nothing;
 *   a valid delivery is 200 after one insert, median under 200 ms (acceptance 1);
 * - with two secrets configured, signatures from either verify (acceptance 8);
 * - no signature header is 400; a body over 1 MiB is 413; no secret configured is 500;
 * - the route needs no user credential (the signature is the credential);
 * - a store failure is 500 (Stripe redelivers): nothing is acknowledged that is not stored.
 */
import { describe, expect, it } from 'vitest';
import { eventBody, sign, webhookHarness, webhookSecret } from './helpers.js';

describe('POST /internal/stripe/webhook signatures', () => {
  it('stores a validly signed event and answers 200, fast (acceptance 1)', async () => {
    const h = await webhookHarness();
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const { body } = eventBody('invoice.created', { object: 'invoice', id: 'in_x' });
      const start = performance.now();
      const res = await h.deliver(body);
      times.push(performance.now() - start);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
    }
    expect(h.events.rows.size).toBe(21);
    const median = [...times].sort((a, b) => a - b)[10] ?? Infinity;
    expect(median).toBeLessThan(200);
    await h.app.close();
  });

  it('refuses a wrong signature, a stale timestamp and a tampered body (acceptance 1)', async () => {
    const h = await webhookHarness();
    const { body } = eventBody('customer.subscription.updated', {
      object: 'subscription',
      id: 'sub_x',
    });
    const now = Math.floor(h.clock.now / 1000);
    const cases = [
      { name: 'wrong secret', res: await h.deliver(body, { secret: webhookSecret('Z') }) },
      { name: 'stale', res: await h.deliver(body, { t: now - 301 }) },
      {
        name: 'tampered',
        res: await h.deliver(body.replace('sub_x', 'sub_y'), {
          signature: sign(body, h.secrets[0] ?? '', now),
        }),
      },
      { name: 'malformed header', res: await h.deliver(body, { signature: 'v1=abc' }) },
      { name: 'no header', res: await h.deliver(body, { signature: null }) },
    ];
    for (const { name, res } of cases) {
      expect(res.statusCode, name).toBe(400);
      expect(res.json(), name).toMatchObject({ code: 'invalid_request' });
    }
    expect(h.events.rows.size).toBe(0);
    expect(h.queued).toEqual([]);
    // A signature just inside the window is fine.
    expect((await h.deliver(body, { t: now - 299 })).statusCode).toBe(200);
    await h.app.close();
  });

  it('refuses a signed body that is not a Stripe event', async () => {
    const h = await webhookHarness();
    for (const body of [
      'not json',
      '{"id":"evt_1"}',
      JSON.stringify({ id: 'nope', type: 'x', created: 1, data: {} }),
    ]) {
      expect((await h.deliver(body)).statusCode, body).toBe(400);
    }
    expect(h.events.rows.size).toBe(0);
    await h.app.close();
  });

  it('accepts signatures from either of two secrets while rolling (acceptance 8)', async () => {
    const h = await webhookHarness({ secrets: [webhookSecret('N'), webhookSecret('O')] });
    const a = eventBody('invoice.created', { object: 'invoice' });
    const b = eventBody('invoice.created', { object: 'invoice' });
    expect((await h.deliver(a.body, { secret: webhookSecret('N') })).statusCode).toBe(200);
    expect((await h.deliver(b.body, { secret: webhookSecret('O') })).statusCode).toBe(200);
    expect(
      (await h.deliver(eventBody('x.y', {}).body, { secret: webhookSecret('P') })).statusCode,
    ).toBe(400);
    expect(h.events.rows.size).toBe(2);
    await h.app.close();
  });

  it('caps the body at 1 MiB, and answers 500 with no secret configured', async () => {
    const h = await webhookHarness();
    const big = eventBody('invoice.created', { object: 'invoice', pad: 'x'.repeat(1_048_600) });
    expect((await h.deliver(big.body)).statusCode).toBe(413);
    const unconfigured = await webhookHarness({ secrets: [] });
    const res = await unconfigured.deliver(eventBody('invoice.created', {}).body, {
      signature: 't=1,v1=' + 'a'.repeat(64),
    });
    expect(res.statusCode).toBe(500);
    await h.app.close();
    await unconfigured.app.close();
  });

  it('answers 500 when the event cannot be stored, and 200 once it can', async () => {
    const h = await webhookHarness();
    const { body } = eventBody('invoice.created', { object: 'invoice' });
    h.events.failInsert = true;
    expect((await h.deliver(body)).statusCode).toBe(500);
    h.events.failInsert = false;
    expect((await h.deliver(body)).statusCode).toBe(200);
    await h.app.close();
  });
});

describe('STRIPE_WEBHOOK_SECRET', () => {
  it('takes one or two secrets, comma-separated, and refuses anything else', async () => {
    const { loadStripeConfig } =
      await import('../../../src/modules/billing/stripe/stripe-client.js');
    const { testSecretKey } = await import('../subscriptions/helpers.js');
    const env = (secret: string) => ({
      STRIPE_SECRET_KEY: testSecretKey(),
      STRIPE_WEBHOOK_SECRET: secret,
    });
    const one = loadStripeConfig(env(webhookSecret('A')));
    expect(one?.webhookSecrets?.map((s) => s.reveal())).toEqual([webhookSecret('A')]);
    expect(one?.webhookSecret?.reveal()).toBe(webhookSecret('A'));
    const two = loadStripeConfig(env(`${webhookSecret('A')}, ${webhookSecret('B')}`));
    expect(two?.webhookSecrets?.map((s) => s.reveal())).toEqual([
      webhookSecret('A'),
      webhookSecret('B'),
    ]);
    expect(() =>
      loadStripeConfig(env([webhookSecret('A'), webhookSecret('B'), webhookSecret('C')].join(','))),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => loadStripeConfig(env(`${webhookSecret('A')},nope`))).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
    expect(loadStripeConfig({ STRIPE_SECRET_KEY: testSecretKey() })?.webhookSecrets).toEqual([]);
  });
});
