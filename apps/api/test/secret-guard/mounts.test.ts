/**
 * The credential-leak guard (B101) as MOUNTED in the API, not as a library: a request that carries a provider
 * credential is refused before any handler runs, with the same body whatever the pattern and without the
 * credential in it, the service's own Authorization header is not scanned, the telemetry route stays 204 and
 * drops the event instead, every log line the services write is redacted, and an event with a credential in an
 * allowed prop is dropped from a telemetry batch. Each test fails if the mount is removed.
 */
import { createMemoryRedis } from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { API_MODULES } from '../../src/modules.js';
import { loadApiConfig } from '../../src/config.js';
import { createContext, type ApiDatabase } from '../../src/context.js';
import { captureMailer, testEnv } from '../entrypoint/helpers.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { telemetryRoutes } from '../../src/routes/telemetry.js';
import { batch, event, post, telemetryApp } from '../telemetry/helpers.js';

// Built at run time: the repository's own secret scan has nothing to match in this file.
const ANTHROPIC = ['sk', 'ant', 'api03', 'Zq8WmN3xK7vB2cT5yH9jL4pR6'].join('-');
const AWS = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');

async function build() {
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const db = createDb<ApiDatabase>({
    url: 'postgres://centcom:test@127.0.0.1:1/none',
    poolMax: 1,
    connectTimeoutMs: 300,
  });
  const app = await buildApp({
    config: loadApiConfig(testEnv({})),
    db,
    redis: createMemoryRedis(),
    logger: captured.logger,
    metrics: recorded.metrics,
    mailer: captureMailer(),
  });
  await app.ready();
  return { app, captured, recorded, close: async () => (await app.close(), closeDb(db)) };
}

describe('REST (surface 2)', () => {
  it('refuses a credential in the query, a header and a body, with one body for every pattern and none of the text', async () => {
    const t = await build();
    const bodies: string[] = [];
    for (const [url, headers, payload] of [
      [`/healthz?next=${ANTHROPIC}`, {}, undefined],
      [`/healthz?next=${AWS}`, {}, undefined],
      ['/healthz', { 'x-note': ANTHROPIC }, undefined],
      [
        '/login/email',
        { 'content-type': 'application/x-www-form-urlencoded' },
        `email=a%40b.test&return_to=${ANTHROPIC}`,
      ],
    ] as const) {
      const res = await t.app.inject({
        method: payload === undefined ? 'GET' : 'POST',
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('invalid_request');
      expect(res.body).not.toContain(ANTHROPIC);
      expect(res.body).not.toContain(AWS);
      bodies.push(
        JSON.stringify({ ...res.json<object>(), instance: undefined, request_id: undefined }),
      );
    }
    // the two query cases (different patterns) answer identically: no oracle for probing
    expect(bodies[0]).toBe(bodies[1]);
    await t.close();
  });

  it('counts and logs a hit by pattern id only, never the text', async () => {
    const t = await build();
    await t.app.inject({ method: 'GET', url: `/healthz?next=${ANTHROPIC}` });
    expect(
      t.recorded.count('secret_guard_hits_total', {
        surface: 'rest',
        pattern: 'anthropic_api_key',
      }),
    ).toBe(1);
    const raw = t.captured.raw();
    expect(raw).toContain('secret_guard_hit');
    expect(raw).not.toContain(ANTHROPIC);
    await t.close();
  });

  it('passes a clean request, and does not scan the Authorization header (the service’s own token)', async () => {
    const t = await build();
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const jwtLike = [
      'eyJhbGciOiJFZERTQSJ9',
      'eyJzdWIiOiJ1c3JfMSJ9',
      'c2lnbmF0dXJlc2lnbmF0dXJl',
    ].join('.');
    const res = await t.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: `Bearer ${jwtLike}` },
    });
    expect(res.statusCode).toBe(200);
    await t.close();
  });
});

describe('the logger (surface 1)', () => {
  it('redacts a credential in a message and in fields of every line the services write', async () => {
    const captured = captureLogger();
    const db = createDb<ApiDatabase>({
      url: 'postgres://centcom:test@127.0.0.1:1/none',
      poolMax: 1,
      connectTimeoutMs: 300,
    });
    const ctx = createContext({
      config: loadApiConfig(testEnv({})),
      db,
      redis: createMemoryRedis(),
      logger: captured.logger,
    });
    ctx.logger.info(
      { upstream: ANTHROPIC, nested: { header: `x ${AWS}` } },
      `failed with ${ANTHROPIC}`,
    );
    const raw = captured.raw();
    expect(raw).not.toContain(ANTHROPIC);
    expect(raw).not.toContain(AWS);
    expect(raw).toContain('[redacted:anthropic_api_key]');
    expect(raw).toContain('[redacted:aws_access_key]');
    await closeDb(db);
  });
});

describe('telemetry (surface 3)', () => {
  it('drops an event whose allowed prop holds a credential, keeps the others and still answers 204', async () => {
    const t = await telemetryApp();
    // 31 lower-case characters pass the command-name shape, so only the guard can stop this one.
    const smuggled = ['sk', 'ant', 'aaaaaaaaaaaaaaaaaaaaaaaa'].join('-');
    const res = await post(
      t.app,
      batch([
        event('command.run', { name: smuggled }),
        event('command.run', { name: 'session join' }),
      ]),
    );
    expect(res.statusCode).toBe(204);
    expect(t.repo.rows.map((r) => r.props['name'])).toEqual(['session join']);
    expect(t.recorded.count('telemetry_dropped_total', { reason: 'pii_pattern' })).toBe(1);
    expect(
      t.recorded.count('secret_guard_hits_total', {
        surface: 'telemetry',
        pattern: 'anthropic_api_key',
      }),
    ).toBe(1);
    expect(t.captured.raw()).not.toContain(smuggled);
  });

  it('is not turned into a 400 by the REST guard: the route answers 204 as the contract says (route mounted in a test module list)', async () => {
    const th = await telemetryApp();
    const db = createDb<ApiDatabase>({
      url: 'postgres://centcom:test@127.0.0.1:1/none',
      poolMax: 1,
      connectTimeoutMs: 300,
    });
    const app = await buildApp(
      {
        config: loadApiConfig(testEnv({})),
        db,
        redis: createMemoryRedis(),
        logger: captureLogger().logger,
        mailer: captureMailer(),
      },
      {
        modules: [
          ...API_MODULES,
          {
            name: 'telemetry',
            register: async (scope) => {
              await scope.register(telemetryRoutes, { ingest: th.ingest });
            },
          },
        ],
      },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/telemetry/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(batch([event('app.start', { note: ANTHROPIC })])),
    });
    expect(res.statusCode, res.body).toBe(204);
    await app.close();
    await closeDb(db);
  });
});
