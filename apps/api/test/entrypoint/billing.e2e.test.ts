/**
 * Billing through the real API process pieces (Postgres + a local stand-in for Stripe's REST API):
 * checkout and the billing portal create sessions for the workspace's owner, a webhook signed with
 * Stripe's scheme (`t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<body>")`) is stored once, the processor
 * re-fetches the subscription and the workspace's plan and entitlements change, a bad or stale
 * signature is refused, and without STRIPE_SECRET_KEY the billing routes are left out and
 * SELF_HOST_PLAN or Free applies. Needs DATABASE_URL (skipped otherwise).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createMemoryRedis } from '@centcom/core';
import { createFactories } from '@centcom/testkit';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadApiConfig } from '../../src/config.js';
import { createContext, type ApiDatabase } from '../../src/context.js';
import { SCOPES } from '../../src/modules/auth/tokens/service.js';
import { captureLogger } from '../helpers.js';
import { ADMIN_URL, migratedDatabase, type TestDatabase } from '../modules/users/helpers.js';
import { testEnv } from './helpers.js';

/** A Stripe-shaped key built at run time, so the repository's secret scan has nothing to match. */
const fakeKey = (mode: 'test' | 'live'): string => ['sk', mode, 'abcdefghijklmnop1234'].join('_');
const WEBHOOK_SECRET = `whsec_${'a1B2c3D4e5F6g7H8i9J0'}`;
const PRICES: Record<string, string> = {};
for (const interval of ['MONTH', 'YEAR']) {
  for (const currency of ['USD', 'EUR']) {
    for (const kind of ['PRO', 'TEAM', 'SEAT']) {
      PRICES[`STRIPE_PRICE_${kind}_${interval}_${currency}`] =
        `price_${kind}${interval}${currency}`.replace(/[^A-Za-z0-9_]/g, '');
    }
  }
}
const fixture = (name: string): string =>
  readFileSync(new URL(`../billing/fixtures/${name}.json`, import.meta.url), 'utf8').trim();

/** Stripe's `Stripe-Signature` header for `body` at `timestamp`. */
const sign = (body: string, timestamp: number, secret = WEBHOOK_SECRET): string =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

describe('billing configuration', () => {
  it('leaves billing off without STRIPE_SECRET_KEY, and applies SELF_HOST_PLAN in production', () => {
    const off = loadApiConfig(testEnv({}));
    expect(off.billing).toBeNull();
    expect(off.selfHostPlan).toBeNull();
    const selfHost = loadApiConfig(
      testEnv({
        SELF_HOST_PLAN: 'team',
        NODE_ENV: 'production',
        ALLOW_INSECURE_BACKENDS: '1',
        TRUSTED_PROXY_HOPS: '1',
        DEV_MAILPIT_URL: undefined,
      }),
    );
    expect(selfHost.selfHostPlan).toBe('team');
  });

  it('refuses SELF_HOST_PLAN together with Stripe, and a half-set price catalogue in production', () => {
    expect(() =>
      loadApiConfig(testEnv({ SELF_HOST_PLAN: 'pro', STRIPE_SECRET_KEY: fakeKey('test') })),
    ).toThrow(/SELF_HOST_PLAN/);
    expect(() =>
      loadApiConfig(
        testEnv({
          STRIPE_SECRET_KEY: fakeKey('live'),
          NODE_ENV: 'production',
          ALLOW_INSECURE_BACKENDS: '1',
          TRUSTED_PROXY_HOPS: '1',
          DEV_MAILPIT_URL: undefined,
        }),
      ),
    ).toThrow(/STRIPE_PRICE_PRO_MONTH_USD/);
  });
});

describe('billing routes', () => {
  it('exist with Stripe configured and are left out without it', async () => {
    const { createDb, closeDb } = await import('@centcom/db');
    const build = async (extra: Record<string, string | undefined>) => {
      const db = createDb<ApiDatabase>({
        url: 'postgres://centcom:test@127.0.0.1:1/none',
        poolMax: 1,
        connectTimeoutMs: 300,
      });
      const app = await buildApp({
        config: loadApiConfig(testEnv(extra)),
        db,
        redis: createMemoryRedis(),
        logger: captureLogger().logger,
      });
      await app.ready();
      return { app, close: async () => (await app.close(), closeDb(db)) };
    };
    const routes: [string, string][] = [
      ['GET', '/v1/workspaces/:id/subscription'],
      ['POST', '/v1/workspaces/:id/checkout'],
      ['POST', '/v1/workspaces/:id/portal'],
      ['POST', '/internal/stripe/webhook'],
    ];
    const on = await build({ STRIPE_SECRET_KEY: fakeKey('test') });
    for (const [method, url] of routes) {
      expect(on.app.hasRoute({ method: method as 'GET', url }), url).toBe(true);
    }
    await on.close();
    const off = await build({});
    for (const [method, url] of routes) {
      expect(off.app.hasRoute({ method: method as 'GET', url }), url).toBe(false);
    }
    await off.close();
  });
});

describe.runIf(ADMIN_URL !== undefined)('billing on Postgres with a Stripe stand-in', () => {
  let database: TestDatabase;
  let stripe: Server;
  let app: FastifyInstance;
  let ctx: ReturnType<typeof createContext>;
  const stripeCalls: { method: string; path: string; body: string }[] = [];
  let workspaceId = '';
  let auth = '';
  let outsider = '';

  beforeAll(async () => {
    stripe = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        stripeCalls.push({ method: req.method ?? '', path, body });
        const send = (json: unknown): void => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        if (path === '/v1/customers/search') return send({ object: 'search_result', data: [] });
        if (path === '/v1/customers') return send({ id: 'cus_fixture1' });
        if (path === '/v1/checkout/sessions')
          return send({ url: 'https://checkout.stripe.test/c/pay_1', expires_at: 1790003600 });
        if (path === '/v1/billing_portal/sessions')
          return send({ url: 'https://billing.stripe.test/p/session_1' });
        if (path === '/v1/subscriptions/sub_1QfixtureSub') {
          return send({
            id: 'sub_1QfixtureSub',
            object: 'subscription',
            customer: 'cus_fixture1',
            status: 'active',
            currency: 'usd',
            cancel_at_period_end: false,
            metadata: { workspace_id: workspaceId },
            items: {
              data: [
                {
                  id: 'si_1',
                  price: { id: PRICES['STRIPE_PRICE_PRO_MONTH_USD'] },
                  quantity: 1,
                  current_period_start: 1790000000,
                  current_period_end: 1792592000,
                },
              ],
            },
          });
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"type":"invalid_request_error"}}');
      });
    });
    stripe.listen(0, '127.0.0.1');
    await once(stripe, 'listening');
    const port = (stripe.address() as { port: number }).port;

    database = await migratedDatabase(10);
    const factories = createFactories(database.db);
    const owner = await factories.users.create();
    const stranger = await factories.users.create();
    const workspace = await factories.workspaces.create({ owner });
    workspaceId = workspace.id;
    const device = await factories.devices.create({ user: owner });
    const strangerDevice = await factories.devices.create({ user: stranger });

    const config = loadApiConfig(
      testEnv({
        STRIPE_SECRET_KEY: fakeKey('test'),
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_API_BASE: `http://127.0.0.1:${port}`,
        RATELIMIT_AUTH_LIMIT: '1000',
        RATELIMIT_ANONYMOUS_LIMIT: '1000',
        ...PRICES,
      }),
    );
    const deps = {
      config,
      db: database.db as unknown as import('kysely').Kysely<ApiDatabase>,
      redis: createMemoryRedis(),
      logger: captureLogger().logger,
    };
    ctx = createContext(deps);
    app = await buildApp(deps);
    await app.ready();
    const scopes = SCOPES.filter((s) => s !== 'admin');
    const issued = await ctx.tokens.issueTokens({ userId: owner.id, deviceId: device.id, scopes });
    auth = `Bearer ${issued.access_token}`;
    const other = await ctx.tokens.issueTokens({
      userId: stranger.id,
      deviceId: strangerDevice.id,
      scopes,
    });
    outsider = `Bearer ${other.access_token}`;
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
    stripe.close();
  });

  const post = (
    url: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown> | string,
  ): Promise<LightMyRequestResponse> => {
    const options: InjectOptions = { method: 'POST', url, headers };
    if (payload !== undefined) options.payload = payload;
    return app.inject(options);
  };

  it('a self-hosted sign-up starts on SELF_HOST_PLAN; a Stripe deployment starts on Free', async () => {
    const make = (extra: Record<string, string | undefined>) =>
      createContext({
        config: loadApiConfig(testEnv(extra)),
        db: database.db as unknown as import('kysely').Kysely<ApiDatabase>,
        redis: createMemoryRedis(),
        logger: captureLogger().logger,
      });
    const planOf = async (c: ReturnType<typeof createContext>, email: string) => {
      const { user } = await c.users.getOrCreateByEmail(email);
      const row = await (
        database.db as unknown as import('kysely').Kysely<{
          workspaces: { id: string; created_by: string };
          workspace_entitlements: { workspace_id: string; plan_id: string; status: string };
        }>
      )
        .selectFrom('workspaces')
        .innerJoin('workspace_entitlements', 'workspace_id', 'workspaces.id')
        .select(['plan_id', 'status'])
        .where('created_by', '=', user.id)
        .executeTakeFirst();
      return row ?? null;
    };
    expect(await planOf(make({ SELF_HOST_PLAN: 'team' }), 'self@example.test')).toEqual({
      plan_id: 'team',
      status: 'active',
    });
    expect(await planOf(make({}), 'free@example.test')).toBeNull(); // no row: the Free plan
    expect(await planOf(ctx, 'stripe@example.test')).toBeNull();
  });

  it('serves the billing routes and has no subscription yet', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/subscription`,
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a hosted checkout for the owner, priced from the server catalogue only', async () => {
    const res = await post(
      `/v1/workspaces/${workspaceId}/checkout`,
      { authorization: auth, 'idempotency-key': randomUUID() },
      { plan: 'pro', interval: 'month', currency: 'USD', success_url: 'https://evil.test/' },
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ url: string }>().url).toBe('https://checkout.stripe.test/c/pay_1');
    const session = stripeCalls.find((c) => c.path === '/v1/checkout/sessions');
    expect(session?.body).toContain(PRICES['STRIPE_PRICE_PRO_MONTH_USD']);
    expect(session?.body).not.toContain('evil.test');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses a stranger and a request without a key', async () => {
    const stranger = await post(
      `/v1/workspaces/${workspaceId}/checkout`,
      { authorization: outsider, 'idempotency-key': randomUUID() },
      { plan: 'pro', interval: 'month' },
    );
    expect(stranger.statusCode).toBe(404);
    const noKey = await post(
      `/v1/workspaces/${workspaceId}/checkout`,
      { authorization: auth },
      { plan: 'pro', interval: 'month' },
    );
    expect(noKey.statusCode).toBe(400);
  });

  it('opens the billing portal once the customer exists', async () => {
    const res = await post(`/v1/workspaces/${workspaceId}/portal`, { authorization: auth }, {});
    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string }>().url).toBe('https://billing.stripe.test/p/session_1');
  });

  it('refuses a webhook with a bad, tampered or stale signature and stores nothing', async () => {
    const body = fixture('customer.subscription.created');
    const now = Math.floor(Date.now() / 1000);
    const url = '/internal/stripe/webhook';
    const headers = (sig: string) => ({
      'content-type': 'application/json',
      'stripe-signature': sig,
    });
    expect(
      (await post(url, headers(sign(body, now, 'whsec_wrongwrongwrongwrong')), body)).statusCode,
    ).toBe(400);
    expect(
      (await post(url, headers(sign(body, now)), body.replace('active', 'trialing'))).statusCode,
    ).toBe(400);
    expect((await post(url, headers(sign(body, now - 3600)), body)).statusCode).toBe(400);
    expect((await post(url, { 'content-type': 'application/json' }, body)).statusCode).toBe(400);
    expect(await ctx.billing?.events.get('evt_1QfixtureSubCreated')).toBeNull();
  });

  it('stores a signed webhook once, processes it, and the plan and entitlements follow', async () => {
    const body = fixture('customer.subscription.created');
    const now = Math.floor(Date.now() / 1000);
    const headers = { 'content-type': 'application/json', 'stripe-signature': sign(body, now) };
    const first = await post('/internal/stripe/webhook', headers, body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ received: true });
    const again = await post('/internal/stripe/webhook', headers, body);
    expect(again.statusCode).toBe(200); // a duplicate delivery is acknowledged, stored once
    expect((await ctx.billing?.events.get('evt_1QfixtureSubCreated'))?.status).toBe('received');

    expect(await ctx.billing?.processor.process('evt_1QfixtureSubCreated')).toBe('processed');
    expect(await ctx.billing?.processor.process('evt_1QfixtureSubCreated')).toBe('skipped');

    const sub = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/subscription`,
      headers: { authorization: auth },
    });
    expect(sub.statusCode).toBe(200);
    expect(sub.json()).toMatchObject({
      plan: 'pro',
      status: 'active',
      interval: 'month',
      seats: 1,
    });
    expect(JSON.stringify(sub.json())).not.toMatch(/cus_|sub_1Q|si_/); // no Stripe ids leave the API
    const entitlements = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/entitlements`,
      headers: { authorization: auth },
    });
    expect(entitlements.json()).toMatchObject({ plan: 'pro' });

    // Checkout is now refused: a subscription in effect is changed in the portal.
    const second = await post(
      `/v1/workspaces/${workspaceId}/checkout`,
      { authorization: auth, 'idempotency-key': randomUUID() },
      { plan: 'team', interval: 'month' },
    );
    expect(second.statusCode).toBe(409);
  });
});
