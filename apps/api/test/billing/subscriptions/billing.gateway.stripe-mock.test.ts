/**
 * `StripeClient` over HTTP (B070 acceptance 5, guardrails "idempotency key on every write", "pin
 * the API version"), against a local Stripe stand-in that records every request: the secret key
 * as a bearer token, the pinned `Stripe-Version`, form-encoded bodies nested as Stripe reads them,
 * and the caller's `Idempotency-Key` on writes. 5xx, 409, 429 and timeouts are retried 3 times
 * with full-jitter backoff and the same key, then fail as `unavailable`; `Stripe-Should-Retry`
 * overrides the status; other 4xx fail at once (`request`, `auth`). Subscriptions parse from the
 * pinned version's shape (periods on items). Webhook signatures verify, and tampered, stale or
 * malformed ones do not. With STRIPE_MOCK_URL set (the official stripe-mock), the calls also run
 * against it.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineConfig, Secret, z } from '@centcom/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeError } from '../../../src/modules/billing/stripe/gateway.js';
import {
  formEncode,
  STRIPE_API_VERSION_DEFAULT,
  STRIPE_BACKOFF_BASE_MS,
  StripeClient,
  type StripeConfig,
} from '../../../src/modules/billing/stripe/stripe-client.js';
import { newId, stripeId, testSecretKey } from './helpers.js';

type Recorded = { method: string; url: string; headers: IncomingMessage['headers']; body: string };
type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

let server: Server;
let base = '';
const recorded: Recorded[] = [];
let script: Answer[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const answer = script.shift() ?? { status: 500 };
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body === undefined ? '{}' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(overrides: Partial<StripeConfig> = {}, fetchImpl?: typeof fetch) {
  recorded.length = 0;
  const sleeps: number[] = [];
  const webhookSecret = ['whsec', 'dGVzdHNlY3JldGZvcndlYmhvb2tz'].join('_');
  const config: StripeConfig = {
    secretKey: new Secret(testSecretKey()),
    apiVersion: STRIPE_API_VERSION_DEFAULT,
    webhookSecret: new Secret(webhookSecret),
    apiBase: base,
    ...overrides,
  };
  const c = new StripeClient({
    config,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    clock: () => Date.UTC(2026, 9, 8, 12, 0, 0),
  });
  return { c, sleeps, webhookSecret };
}

const form = (body: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(body).entries());

const subscriptionJson = (id = stripeId('sub'), customer = stripeId('cus')) => ({
  object: 'subscription',
  id,
  customer,
  status: 'active',
  currency: 'eur',
  cancel_at_period_end: false,
  metadata: { workspace_id: newId('wsp') },
  items: {
    object: 'list',
    data: [
      {
        id: stripeId('si'),
        price: { id: 'price_teammonthEUR' },
        quantity: 1,
        current_period_start: 1790812800,
        current_period_end: 1793491200,
      },
    ],
  },
});

describe('StripeClient requests', () => {
  it('creates a customer with the key, the pinned version, the idempotency key and a form body', async () => {
    const { c } = client();
    const ws = newId('wsp');
    script = [{ status: 200, body: { id: 'cus_A1b2C3', object: 'customer' } }];
    const result = await c.createCustomer(
      { workspaceId: ws, email: 'pay@acme.test', name: 'Acme', locale: 'de-DE' },
      `centcom-${ws}-customer-create`,
    );
    expect(result).toEqual({ id: 'cus_A1b2C3' });
    const [request] = recorded;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/v1/customers');
    expect(request?.headers['authorization']).toBe(`Bearer ${testSecretKey()}`);
    expect(request?.headers['stripe-version']).toBe('2025-03-31.basil');
    expect(request?.headers['idempotency-key']).toBe(`centcom-${ws}-customer-create`);
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form(request?.body ?? '')).toEqual({
      email: 'pay@acme.test',
      name: 'Acme',
      'preferred_locales[0]': 'de-DE',
      'metadata[workspace_id]': ws,
    });
  });

  it('retries a 5xx with the same idempotency key, then succeeds', async () => {
    const { c, sleeps } = client();
    script = [{ status: 500 }, { status: 503 }, { status: 200, body: { id: 'cus_Ok1' } }];
    expect(await c.createCustomer({ workspaceId: newId('wsp'), email: 'a@b.test' }, 'k-1')).toEqual(
      {
        id: 'cus_Ok1',
      },
    );
    expect(recorded.map((r) => r.headers['idempotency-key'])).toEqual(['k-1', 'k-1', 'k-1']);
    expect(sleeps).toEqual([STRIPE_BACKOFF_BASE_MS / 2, STRIPE_BACKOFF_BASE_MS]);
  });

  it('gives up after 3 retries as unavailable', async () => {
    const { c, sleeps } = client();
    script = [{ status: 500 }, { status: 502 }, { status: 429 }, { status: 409 }];
    const error = await c
      .createCustomer({ workspaceId: newId('wsp'), email: 'a@b.test' }, 'k-2')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect((error as StripeError).kind).toBe('unavailable');
    expect(recorded).toHaveLength(4);
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  it('retries timeouts and network errors, then fails as unavailable', async () => {
    let calls = 0;
    const failing: typeof fetch = () => {
      calls += 1;
      return Promise.reject(
        calls % 2 === 0
          ? new TypeError('fetch failed')
          : new DOMException('timed out', 'TimeoutError'),
      );
    };
    const { c } = client({}, failing);
    await expect(
      c.createCustomer({ workspaceId: newId('wsp'), email: 'a@b.test' }, 'k-3'),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(calls).toBe(4);
  });

  it('fails at once on a 4xx, and follows Stripe-Should-Retry', async () => {
    const { c } = client();
    script = [
      {
        status: 400,
        body: { error: { type: 'invalid_request_error', code: 'parameter_missing' } },
      },
    ];
    await expect(
      c.createCustomer({ workspaceId: newId('wsp'), email: 'a@b.test' }, 'k-4'),
    ).rejects.toMatchObject({
      kind: 'request',
      status: 400,
      stripeCode: 'parameter_missing',
    });
    expect(recorded).toHaveLength(1);

    const { c: c2 } = client();
    script = [{ status: 401 }];
    await expect(
      c2.createCustomer({ workspaceId: newId('wsp'), email: 'a@b.test' }, 'k-5'),
    ).rejects.toMatchObject({
      kind: 'auth',
    });

    const { c: c3 } = client();
    script = [{ status: 500, headers: { 'stripe-should-retry': 'false' } }];
    await expect(
      c3.createCustomer({ workspaceId: newId('wsp'), email: 'a@b.test' }, 'k-6'),
    ).rejects.toMatchObject({
      kind: 'request',
    });
    expect(recorded).toHaveLength(1);

    const { c: c4 } = client();
    script = [
      { status: 400, headers: { 'stripe-should-retry': 'true' } },
      { status: 200, body: { id: 'cus_Retried' } },
    ];
    expect(
      await c4.createCustomer({ workspaceId: newId('wsp'), email: 'a@b.test' }, 'k-7'),
    ).toEqual({
      id: 'cus_Retried',
    });
  });

  it('searches customers by workspace metadata', async () => {
    const { c } = client();
    const ws = newId('wsp');
    script = [{ status: 200, body: { object: 'search_result', data: [{ id: 'cus_Found1' }] } }];
    expect(await c.findCustomerByWorkspace(ws)).toEqual({ id: 'cus_Found1' });
    const url = new URL(recorded[0]?.url ?? '', base);
    expect(url.pathname).toBe('/v1/customers/search');
    expect(url.searchParams.get('query')).toBe(`metadata['workspace_id']:'${ws}'`);
    expect(recorded[0]?.headers['idempotency-key']).toBeUndefined();
    script = [{ status: 200, body: { object: 'search_result', data: [] } }];
    expect(await c.findCustomerByWorkspace(ws)).toBeNull();
    expect(await c.findCustomerByWorkspace("wsp_x' OR 1")).toBeNull();
  });

  it('retrieves and parses a subscription of the pinned version', async () => {
    const { c } = client();
    const json = subscriptionJson();
    script = [{ status: 200, body: json }];
    const sub = await c.retrieveSubscription(json.id);
    expect(recorded[0]?.url).toBe(`/v1/subscriptions/${json.id}`);
    expect(sub).toMatchObject({
      id: json.id,
      customerId: json.customer,
      status: 'active',
      currency: 'EUR',
      periodStart: 1790812800,
      periodEnd: 1793491200,
      workspaceId: json.metadata.workspace_id,
    });
    expect(sub.items).toEqual([
      expect.objectContaining({ priceId: 'price_teammonthEUR', quantity: 1 }),
    ]);
    script = [{ status: 200, body: { object: 'customer', id: 'cus_X' } }];
    await expect(c.retrieveSubscription(json.id)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('updates subscription items with the idempotency key and nested items', async () => {
    const { c } = client();
    const json = subscriptionJson();
    script = [{ status: 200, body: json }];
    await c.updateSubscriptionItems(
      {
        subscriptionId: json.id,
        items: [
          { id: 'si_Seat1', priceId: 'price_seatmonthEUR', quantity: 4 },
          { priceId: 'price_new', quantity: 1 },
        ],
      },
      'k-items',
    );
    expect(recorded[0]?.headers['idempotency-key']).toBe('k-items');
    expect(form(recorded[0]?.body ?? '')).toEqual({
      'items[0][id]': 'si_Seat1',
      'items[0][quantity]': '4',
      'items[1][price]': 'price_new',
      'items[1][quantity]': '1',
      proration_behavior: 'create_prorations',
    });
  });
});

describe('formEncode', () => {
  it('nests objects and arrays as Stripe reads them, and skips undefined', () => {
    expect(
      formEncode({
        a: 'x y',
        b: 1,
        c: true,
        d: undefined,
        e: { f: 'g', h: undefined },
        i: [{ j: 'k' }, 'l'],
      }),
    ).toBe('a=x%20y&b=1&c=true&e%5Bf%5D=g&i%5B0%5D%5Bj%5D=k&i%5B1%5D=l');
  });
});

describe('constructEvent', () => {
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: 1791460800,
    data: { object: { id: 'sub_1' } },
  });
  const sign = (secret: string, t: number, payload = body) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  const now = Date.UTC(2026, 9, 8, 12, 0, 0) / 1000;

  it('verifies a signed event and parses it', () => {
    const { c, webhookSecret } = client();
    expect(c.constructEvent(body, sign(webhookSecret, now))).toEqual({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      created: 1791460800,
      object: { id: 'sub_1' },
    });
    expect(
      c.constructEvent(
        Buffer.from(body),
        `${sign('whsec_other', now)},${sign(webhookSecret, now).split(',')[1] ?? ''}`,
      ),
    ).toMatchObject({ id: 'evt_1' });
  });

  it('refuses a tampered, stale, malformed or unconfigured signature', () => {
    const { c, webhookSecret } = client();
    const refused = (fn: () => unknown, kind: string) => {
      try {
        fn();
        expect.unreachable();
      } catch (err) {
        expect((err as StripeError).kind).toBe(kind);
      }
    };
    refused(
      () => c.constructEvent(body.replace('updated', 'deleted'), sign(webhookSecret, now)),
      'signature',
    );
    refused(() => c.constructEvent(body, sign(webhookSecret, now - 301)), 'signature');
    refused(() => c.constructEvent(body, sign('whsec_wrong', now)), 'signature');
    refused(() => c.constructEvent(body, 'v1=abc'), 'signature');
    refused(() => c.constructEvent(body, ''), 'signature');
    const { c: off } = client({ webhookSecret: null });
    refused(() => off.constructEvent(body, sign(webhookSecret, now)), 'not_configured');
  });
});

const STRIPE_MOCK_URL = defineConfig(
  z.object({ STRIPE_MOCK_URL: z.string().optional() }),
).STRIPE_MOCK_URL;

describe.runIf(STRIPE_MOCK_URL !== undefined)('StripeClient against stripe-mock', () => {
  it('creates a customer and reads a subscription', async () => {
    const { c } = client({ apiBase: STRIPE_MOCK_URL ?? '' });
    const customer = await c.createCustomer(
      { workspaceId: newId('wsp'), email: 'mock@example.test' },
      `mock-${Date.now()}`,
    );
    expect(customer.id).toMatch(/^cus_/);
    const sub = await c.retrieveSubscription('sub_123');
    expect(sub.id).toMatch(/^sub_/);
  });
});
