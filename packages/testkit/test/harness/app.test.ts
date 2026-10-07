/**
 * withApp (B010): the app is built before the file's tests, served to them for inject() calls,
 * and closed after them; using it outside a test fails clearly.
 */
import { fastify } from 'fastify';
import { describe, expect, it } from 'vitest';
import { withApp } from '../../src/index.js';

let builds = 0;
const handle = withApp(async () => {
  builds += 1;
  const app = fastify({ logger: false });
  app.get('/v1/ping', async () => ({ pong: true }));
  return app;
});

describe('withApp', () => {
  it('builds the app once, before the tests, ready for inject()', async () => {
    const res = await handle.app.inject({ url: '/v1/ping' });
    expect(res.json()).toEqual({ pong: true });
    expect(builds).toBe(1);
  });

  it('hands every test the same app', async () => {
    expect((await handle.app.inject({ url: '/v1/ping' })).statusCode).toBe(200);
    expect(builds).toBe(1);
  });
});

describe('before the app is built', () => {
  // Read while the file is being collected, before any beforeAll has run.
  const early = withApp(async () => fastify({ logger: false }));
  let error: unknown;
  try {
    void early.app;
  } catch (e) {
    error = e;
  }

  it('says how to use it', () => {
    expect(String(error)).toMatch(/built in beforeAll; use it inside a test/);
    expect(early.app.server).toBeDefined(); // and inside a test, it is there
  });
});
