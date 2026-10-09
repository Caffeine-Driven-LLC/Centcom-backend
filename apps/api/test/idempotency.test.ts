/**
 * Idempotency plugin (B024; card test plugin.test.ts and acceptance 1-9 end to end): the plugin
 * on the API's plugin stack over B009's in-memory KeyValue on a fake clock, with test routes that
 * count their handler runs. `x-test-user` stands in for the B017 auth plugin's principal.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { newId } from '@centcom/contracts';
import {
  createMemoryRedis,
  IDEMPOTENCY_DETAILS,
  RECORD_TTL_MS,
  Secret,
  storeKeyFor,
  validationFailed,
  type KeyValue,
} from '@centcom/core';
import { fastify, type FastifyInstance, type InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorHandlerPlugin } from '../src/plugins/error-handler.js';
import { idempotencyPlugin, type IdempotencyPluginOptions } from '../src/plugins/idempotency.js';
import { requestContextPlugin } from '../src/plugins/request-context.js';
import { captureLogger, recordingMetrics } from './helpers.js';

class FakeClock {
  now = Date.UTC(2026, 9, 7, 12, 0, 0);
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `inner`, failing every call while `down`, or only writes while `writesDown`. */
function flakyKv(inner: KeyValue): KeyValue & { down: boolean; writesDown: boolean } {
  const fail = (): Promise<never> => Promise.reject(new Error('kv down'));
  const kv: KeyValue & { down: boolean; writesDown: boolean } = {
    down: false,
    writesDown: false,
    get: (key) => (kv.down ? fail() : inner.get(key)),
    set: (key, value, opts) => (kv.down || kv.writesDown ? fail() : inner.set(key, value, opts)),
    setIfAbsent: (key, value, ttlMs) => (kv.down ? fail() : inner.setIfAbsent(key, value, ttlMs)),
    del: (key) => (kv.down || kv.writesDown ? fail() : inner.del(key)),
    incr: (key, ttlMs) => (kv.down ? fail() : inner.incr(key, ttlMs)),
    ttl: (key) => (kv.down ? fail() : inner.ttl(key)),
  };
  return kv;
}

/** The API's plugin stack with the idempotency plugin and routes that count their runs. */
async function idemApp(opts: Partial<IdempotencyPluginOptions> = {}) {
  const clock = new FakeClock();
  const kv = flakyKv(createMemoryRedis(clock.read).kv);
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const runs: string[] = [];
  const app = fastify({ logger: false });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(idempotencyPlugin, {
    kv,
    clock: clock.read,
    principal: (request) => {
      const user = request.headers['x-test-user'];
      return typeof user === 'string' ? user : null;
    },
    logger: captured.logger,
    metrics: recorded.metrics,
    ...opts,
  });
  const run = (name: string): void => {
    runs.push(name);
  };
  app.post('/v1/invites', { config: { idempotency: 'required' } }, async (request, reply) => {
    run('invites');
    await sleep(Number(request.headers['x-test-delay'] ?? 0));
    void reply.code(201).header('location', '/v1/invites/1');
    return { id: newId('inv'), body: request.body };
  });
  app.post('/v1/things/:id', { config: { idempotency: 'required' } }, async (request) => {
    run('things');
    return { params: request.params };
  });
  app.post('/v1/telemetry/events', { config: { idempotency: 'accepted' } }, async () => {
    run('telemetry');
    return { accepted: runs.length };
  });
  app.post('/v1/fail', { config: { idempotency: 'required' } }, async () => {
    run('fail');
    throw new Error('the handler broke');
  });
  app.post('/v1/invalid', { config: { idempotency: 'required' } }, async () => {
    run('invalid');
    throw validationFailed([{ pointer: '/name', code: 'required' }]);
  });
  app.post('/v1/cookie', { config: { idempotency: 'accepted' } }, async (_request, reply) => {
    run('cookie');
    void reply
      .header('set-cookie', ['session=abc', 'theme=dark'])
      .header('x-internal-token', 'internal');
    return { ok: true };
  });
  app.post('/v1/big', { config: { idempotency: 'accepted', maxStoredBytes: 100 } }, async () => {
    run('big');
    return { data: 'x'.repeat(200) };
  });
  app.post('/v1/stream', { config: { idempotency: 'accepted' } }, async (_request, reply) => {
    run('stream');
    void reply.type('text/plain');
    return Readable.from(['a', 'b']);
  });
  app.post('/v1/hijack', { config: { idempotency: 'accepted' } }, async (_request, reply) => {
    run('hijack');
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/plain' });
    reply.raw.end('raw');
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH'],
    url: '/v1/multi',
    config: { idempotency: 'accepted' },
    handler: async () => {
      run('multi');
      return { runs: runs.length };
    },
  });
  if (opts.encryptionKey !== undefined) {
    app.post(
      '/v1/keys',
      { config: { idempotency: 'required', sensitiveResponse: true } },
      async (request, reply) => {
        run('keys');
        void reply.code(201);
        return { key: String(request.headers['x-test-secret']) };
      },
    );
  }
  await app.ready();
  return { app, clock, kv, runs, captured, recorded };
}

/** Headers of a request with an Idempotency-Key. */
const keyed = (key: string, extra: Record<string, string> = {}): Record<string, string> => ({
  'idempotency-key': key,
  ...extra,
});

const post = (url: string, payload: object, headers: Record<string, string>): InjectOptions => ({
  method: 'POST',
  url,
  payload,
  headers,
});

describe('the idempotency plugin', () => {
  it('answers a required route without a key with 400 and runs nothing (acceptance 1)', async () => {
    const { app, runs } = await idemApp();
    const response = await app.inject(post('/v1/invites', { email: 'a@example.test' }, {}));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'idempotency_key_required',
      detail: IDEMPOTENCY_DETAILS.keyRequired,
    });
    expect(runs).toEqual([]);
    // An accepted route runs normally without a key, every time.
    await app.inject(post('/v1/telemetry/events', {}, {}));
    const again = await app.inject(post('/v1/telemetry/events', {}, {}));
    expect(again.headers['idempotency-replayed']).toBeUndefined();
    expect(runs).toEqual(['telemetry', 'telemetry']);
  });

  it('runs once for two identical POSTs and replays the first response (acceptance 2)', async () => {
    const { app, runs } = await idemApp();
    const key = randomUUID();
    const request = post('/v1/invites', { email: 'a@example.test', role: 'member' }, keyed(key));
    const first = await app.inject(request);
    const second = await app.inject({
      ...request,
      payload: { role: 'member', email: 'a@example.test' },
    });
    expect(runs).toEqual(['invites']);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.headers['content-type']).toBe(first.headers['content-type']);
    expect(second.headers['location']).toBe('/v1/invites/1');
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(second.headers['idempotency-replayed']).toBe('true');
    // The replay is its own request: its own request id.
    expect(second.headers['x-request-id']).not.toBe(first.headers['x-request-id']);
  });

  it('refuses the same key with a request that differs by one field (acceptance 3)', async () => {
    const { app, runs } = await idemApp();
    const key = randomUUID();
    await app.inject(post('/v1/invites', { email: 'a@example.test', role: 'member' }, keyed(key)));
    const changed = await app.inject(
      post('/v1/invites', { email: 'a@example.test', role: 'admin' }, keyed(key)),
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'idempotency_conflict' });
    // A path parameter is part of the request too.
    const thingKey = randomUUID();
    await app.inject(post('/v1/things/1', {}, keyed(thingKey)));
    expect((await app.inject(post('/v1/things/2', {}, keyed(thingKey)))).statusCode).toBe(409);
    expect(runs).toEqual(['invites', 'things']);
  });

  it.each([
    ['longer than 64 characters', 'a'.repeat(65), 'too_long'],
    ['neither a ULID nor a UUID', 'not-a-key', 'invalid_format'],
  ])(
    'refuses a key %s with a problem pointing at the header (acceptance 4)',
    async (_n, key, code) => {
      const { app, runs } = await idemApp();
      const response = await app.inject(post('/v1/invites', {}, keyed(key)));
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: 'validation_failed',
        errors: [{ pointer: '/headers/idempotency-key', code }],
      });
      expect(runs).toEqual([]);
    },
  );

  it('runs one of 20 concurrent identical requests; the others replay or get 409 (acceptance 5)', async () => {
    const { app, runs, kv } = await idemApp();
    const key = randomUUID();
    const user = newId('usr');
    const request = post(
      '/v1/invites',
      { email: 'a@example.test' },
      keyed(key, { 'x-test-user': user, 'x-test-delay': '40' }),
    );
    const responses = await Promise.all(Array.from({ length: 20 }, () => app.inject(request)));
    expect(runs).toEqual(['invites']);
    const original = responses.filter((r) => r.headers['idempotency-replayed'] === undefined);
    expect(original.map((r) => r.statusCode)).toEqual([201]);
    for (const response of responses) {
      expect([201, 409]).toContain(response.statusCode);
      if (response.statusCode === 201) expect(response.body).toBe(original[0]?.body);
    }
    const stored = await kv.get(storeKeyFor(user, 'POST', '/v1/invites', key));
    expect(JSON.parse(stored ?? '{}')).toMatchObject({ state: 'done', status: 201 });
  });

  it('replays for 24 hours: still at 23 h 59 m, a new request at 24 h (acceptance 6)', async () => {
    const { app, runs, clock } = await idemApp();
    const request = post('/v1/invites', { email: 'a@example.test' }, keyed(randomUUID()));
    await app.inject(request);
    clock.advance(RECORD_TTL_MS - 60_000);
    expect((await app.inject(request)).headers['idempotency-replayed']).toBe('true');
    clock.advance(60_000);
    const later = await app.inject(request);
    expect(later.headers['idempotency-replayed']).toBeUndefined();
    expect(runs).toEqual(['invites', 'invites']);
  });

  it('never keeps a 5xx, so a retry runs again; keeps 4xx and 2xx (acceptance 7)', async () => {
    const { app, runs, recorded } = await idemApp();
    const failing = post('/v1/fail', {}, keyed(randomUUID()));
    expect((await app.inject(failing)).statusCode).toBe(500);
    expect((await app.inject(failing)).statusCode).toBe(500);
    expect(runs).toEqual(['fail', 'fail']);
    expect(recorded.count('idempotency_not_stored_total', { reason: 'server_error' })).toBe(2);
    const invalid = post('/v1/invalid', {}, keyed(randomUUID()));
    const first = await app.inject(invalid);
    const second = await app.inject(invalid);
    expect([first.statusCode, second.statusCode]).toEqual([422, 422]);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.headers['content-type']).toBe('application/problem+json');
    expect(runs).toEqual(['fail', 'fail', 'invalid']);
  });

  it('keeps one key apart for two principals (acceptance 8)', async () => {
    const { app, runs } = await idemApp();
    const key = randomUUID();
    const as = (user: string): InjectOptions =>
      post('/v1/invites', { email: 'a@example.test' }, keyed(key, { 'x-test-user': user }));
    const [alice, bob] = [newId('usr'), newId('usr')];
    const aliceFirst = await app.inject(as(alice));
    const bobFirst = await app.inject(as(bob));
    expect(runs).toEqual(['invites', 'invites']);
    expect(bobFirst.headers['idempotency-replayed']).toBeUndefined();
    expect((await app.inject(as(alice))).body).toBe(aliceFirst.body);
    expect((await app.inject(as(bob))).body).toBe(bobFirst.body);
    expect(aliceFirst.body).not.toBe(bobFirst.body);
  });

  it('keeps sensitive responses encrypted and still replays them (acceptance 9)', async () => {
    const { app, runs, kv } = await idemApp({
      encryptionKey: new Secret(new Uint8Array(randomBytes(32))),
    });
    const secret = randomBytes(16).toString('hex');
    const key = randomUUID();
    const user = newId('usr');
    const request = post(
      '/v1/keys',
      {},
      keyed(key, { 'x-test-user': user, 'x-test-secret': secret }),
    );
    const first = await app.inject(request);
    expect(first.json()).toEqual({ key: secret });
    const stored = (await kv.get(storeKeyFor(user, 'POST', '/v1/keys', key))) ?? '';
    expect(stored).toContain('aes-256-gcm');
    expect(stored).not.toContain(secret);
    const replay = await app.inject(request);
    expect(replay.body).toBe(first.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(runs).toEqual(['keys']);
  });
});

describe('the idempotency plugin guardrails', () => {
  it('never keeps or replays secret-bearing headers', async () => {
    const { app, kv } = await idemApp();
    const key = randomUUID();
    const request = post('/v1/cookie', {}, keyed(key));
    const first = await app.inject(request);
    expect(first.headers['set-cookie']).toEqual(['session=abc', 'theme=dark']);
    const stored = (await kv.get(storeKeyFor(null, 'POST', '/v1/cookie', key))) ?? '';
    expect(stored).not.toContain('session=abc');
    expect(stored).not.toContain('theme=dark');
    expect(stored).not.toContain('internal');
    const replay = await app.inject(request);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(replay.headers['x-internal-token']).toBeUndefined();
    expect(replay.headers['content-type']).toBe(first.headers['content-type']);
  });

  it('serves oversized, streamed and hijacked responses without keeping them', async () => {
    const { app, runs, recorded } = await idemApp();
    for (const url of ['/v1/big', '/v1/stream', '/v1/hijack']) {
      const request = post(url, {}, keyed(randomUUID()));
      const first = await app.inject(request);
      const second = await app.inject(request);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect(second.body).toBe(first.body);
      expect(second.headers['idempotency-replayed']).toBeUndefined();
    }
    expect(runs).toEqual(['big', 'big', 'stream', 'stream', 'hijack', 'hijack']);
    expect(recorded.count('idempotency_not_stored_total', { reason: 'too_large' })).toBe(2);
    expect(recorded.count('idempotency_not_stored_total', { reason: 'unsupported_body' })).toBe(2);
  });

  it('answers a duplicate still running after the wait with 409 conflict and Retry-After: 1', async () => {
    const { app, runs } = await idemApp({ inFlightWaitMs: 30 });
    const request = post('/v1/invites', {}, keyed(randomUUID(), { 'x-test-delay': '300' }));
    const [first, second] = await Promise.all([
      app.inject(request),
      sleep(10).then(() => app.inject(request)),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'conflict', detail: IDEMPOTENCY_DETAILS.inFlight });
    expect(second.headers['retry-after']).toBe('1');
    expect(runs).toEqual(['invites']);
  });

  it('answers 503 on a required route while the store is down, and never runs it', async () => {
    const { app, runs, kv } = await idemApp();
    kv.down = true;
    const response = await app.inject(post('/v1/invites', {}, keyed(randomUUID())));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    expect(response.headers['retry-after']).toBe('1');
    expect(runs).toEqual([]);
  });

  it('runs an accepted route unprotected while the store is down, counted and warned once', async () => {
    const { app, runs, kv, recorded, captured, clock } = await idemApp();
    kv.down = true;
    const request = post('/v1/telemetry/events', {}, keyed(randomUUID()));
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(runs).toEqual(['telemetry', 'telemetry']);
    expect(recorded.count('idempotency_unprotected_total')).toBe(2);
    const warnings = () => captured.lines().filter((l) => l['msg'] === 'idempotency.unprotected');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({ level: 'warn', route: '/v1/telemetry/events' });
    clock.advance(60_000);
    await app.inject(request);
    expect(warnings()).toHaveLength(2);
  });

  it('still answers when the response cannot be kept, and frees nothing it cannot', async () => {
    const { app, kv, recorded, captured } = await idemApp();
    const request = post('/v1/invites', {}, keyed(randomUUID()));
    kv.writesDown = true;
    expect((await app.inject(request)).statusCode).toBe(201);
    expect(recorded.count('idempotency_store_errors_total')).toBe(1);
    expect(captured.lines().some((l) => l['msg'] === 'idempotency.store_failed')).toBe(true);
    const hijack = post('/v1/hijack', {}, keyed(randomUUID()));
    expect((await app.inject(hijack)).statusCode).toBe(200);
    expect(recorded.count('idempotency_store_errors_total')).toBe(2);
  });

  it('applies to POST and PATCH only', async () => {
    const { app, runs } = await idemApp();
    const key = randomUUID();
    const put: InjectOptions = {
      method: 'PUT',
      url: '/v1/multi',
      payload: {},
      headers: keyed(key),
    };
    await app.inject(put);
    expect((await app.inject(put)).headers['idempotency-replayed']).toBeUndefined();
    await app.inject({ ...put, method: 'POST' });
    expect((await app.inject({ ...put, method: 'POST' })).headers['idempotency-replayed']).toBe(
      'true',
    );
    expect(runs).toEqual(['multi', 'multi', 'multi']);
    // PATCH (B073's changeSeats): kept per method, and its query is part of the request.
    const patch: InjectOptions = { ...put, method: 'PATCH', url: '/v1/multi?preview=true' };
    await app.inject(patch);
    expect((await app.inject(patch)).headers['idempotency-replayed']).toBe('true');
    const other = await app.inject({ ...patch, url: '/v1/multi' });
    expect(other.statusCode).toBe(409);
    expect(other.json<{ code: string }>().code).toBe('idempotency_conflict');
    expect(runs).toEqual(['multi', 'multi', 'multi', 'multi']);
  });

  it.each([
    [{ idempotency: 'always' }, 'POST'],
    [{ idempotency: 'required' }, 'GET'],
    [{ idempotency: 'required', sensitiveResponse: true }, 'POST'],
    [{ idempotency: 'required', sensitiveResponse: 'yes' }, 'POST'],
    [{ idempotency: 'accepted', maxStoredBytes: 0 }, 'POST'],
    [{ idempotency: 'accepted', maxStoredBytes: 1.5 }, 'POST'],
    [{ idempotency: 'accepted', maxStoredBytes: 1024 * 1024 + 1 }, 'POST'],
  ])('refuses the route config %j on %s at startup', async (config, method) => {
    const app: FastifyInstance = fastify({ logger: false });
    await app.register(idempotencyPlugin, {
      kv: createMemoryRedis().kv,
      principal: () => null,
    });
    await expect(async () => {
      app.route({
        method: method as 'POST',
        url: '/v1/x',
        config: config as never,
        handler: async () => ({}),
      });
      await app.ready();
    }).rejects.toThrow(TypeError);
    await app.close();
  });
});
