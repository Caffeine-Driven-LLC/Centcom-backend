/**
 * Request context plugin (B005 acceptance 1 and 6): request id selection and echo, repeated
 * headers, and the context following a request through await, timers, nested calls and body
 * parsing, over inject() and over a real socket.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { getRequestContext } from '@centcom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { clientRequestId, REQUEST_ID_HEADER } from '../src/plugins/request-context.js';
import { buildApp, OTHER_REQUEST_ID, REQUEST_ID, REQUEST_ID_PATTERN } from './helpers.js';
import type { FastifyInstance } from 'fastify';

const contextId = (): string | undefined => getRequestContext()?.requestId;

/** Routes reporting the ids the handler sees. */
function routes(app: FastifyInstance): void {
  app.get('/v1/sessions/:id', async (request) => ({ id: request.id, ctx: contextId() }));
  app.get('/v1/async', async () => {
    const seen: (string | undefined)[] = [];
    await sleep(2);
    seen.push(contextId());
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        seen.push(contextId());
        resolve();
      }, 2),
    );
    const nested = async (): Promise<string | undefined> => {
      await sleep(1);
      return Promise.resolve().then(contextId);
    };
    seen.push(await nested(), ...(await Promise.all([nested(), nested()])));
    return { seen };
  });
  app.post('/v1/echo', async (request) => ({ ctx: contextId(), body: request.body }));
}

describe('request id (acceptance 1)', () => {
  it('a request without X-Request-Id gets a generated req_ id, in the header and as request.id', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/sessions/ses_1' });
    const id = res.headers[REQUEST_ID_HEADER];
    expect(id).toMatch(REQUEST_ID_PATTERN);
    expect(res.json()).toEqual({ id, ctx: id });
  });

  it('a request with a valid id gets the same value back', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({
      url: '/v1/sessions/ses_1',
      headers: { 'x-request-id': REQUEST_ID },
    });
    expect(res.headers[REQUEST_ID_HEADER]).toBe(REQUEST_ID);
    expect(res.json()).toEqual({ id: REQUEST_ID, ctx: REQUEST_ID });
  });

  it('an invalid id is replaced, not echoed', async () => {
    const { app } = await buildApp(routes);
    for (const bad of [
      'abc',
      REQUEST_ID.toLowerCase(),
      REQUEST_ID.replace('req_', 'ses_'),
      `${REQUEST_ID}X`,
      `${REQUEST_ID.slice(0, -1)}U`, // U is not Crockford base32
      ' ',
      'req_'.padEnd(5000, '0'),
    ]) {
      const res = await app.inject({ url: '/v1/sessions/ses_1', headers: { 'x-request-id': bad } });
      const id = res.headers[REQUEST_ID_HEADER];
      expect(id, bad.slice(0, 40)).toMatch(REQUEST_ID_PATTERN);
      expect(id).not.toBe(bad);
    }
  });

  it('a repeated header counts by its first value (array or comma-joined)', async () => {
    const { app } = await buildApp(routes);
    const asArray = await app.inject({
      url: '/v1/sessions/ses_1',
      headers: { 'x-request-id': [REQUEST_ID, OTHER_REQUEST_ID] },
    });
    expect(asArray.headers[REQUEST_ID_HEADER]).toBe(REQUEST_ID);
    const joined = await app.inject({
      url: '/v1/sessions/ses_1',
      headers: { 'x-request-id': `${REQUEST_ID}, ${OTHER_REQUEST_ID}` },
    });
    expect(joined.headers[REQUEST_ID_HEADER]).toBe(REQUEST_ID);
    const firstInvalid = await app.inject({
      url: '/v1/sessions/ses_1',
      headers: { 'x-request-id': ['abc', OTHER_REQUEST_ID] },
    });
    expect(firstInvalid.headers[REQUEST_ID_HEADER]).toMatch(REQUEST_ID_PATTERN);
    expect(firstInvalid.headers[REQUEST_ID_HEADER]).not.toBe(OTHER_REQUEST_ID);
  });

  it('uses the injected id generator', async () => {
    const { app } = await buildApp(routes, { newRequestId: () => OTHER_REQUEST_ID });
    const res = await app.inject({ url: '/v1/sessions/ses_1' });
    expect(res.headers[REQUEST_ID_HEADER]).toBe(OTHER_REQUEST_ID);
  });

  it('sets the header on errors and 404s too', async () => {
    const { app } = await buildApp((a) => {
      a.get('/v1/fail', async () => {
        throw new Error('boom');
      });
    });
    const failed = await app.inject({ url: '/v1/fail', headers: { 'x-request-id': REQUEST_ID } });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers[REQUEST_ID_HEADER]).toBe(REQUEST_ID);
    const missing = await app.inject({ url: '/nowhere' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers[REQUEST_ID_HEADER]).toMatch(REQUEST_ID_PATTERN);
  });
});

describe('clientRequestId()', () => {
  it('accepts only a valid req_ id, taking the first of repeated values', () => {
    expect(clientRequestId(REQUEST_ID)).toBe(REQUEST_ID);
    expect(clientRequestId(` ${REQUEST_ID} `)).toBe(REQUEST_ID);
    expect(clientRequestId(`${REQUEST_ID},${OTHER_REQUEST_ID}`)).toBe(REQUEST_ID);
    expect(clientRequestId([OTHER_REQUEST_ID, REQUEST_ID])).toBe(OTHER_REQUEST_ID);
    expect(clientRequestId(undefined)).toBeUndefined();
    expect(clientRequestId([])).toBeUndefined();
    expect(clientRequestId('')).toBeUndefined();
    expect(clientRequestId(`abc,${REQUEST_ID}`)).toBeUndefined();
  });
});

describe('request context (acceptance 6)', () => {
  it('survives await, timers and nested async calls in a handler', async () => {
    const { app } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/async', headers: { 'x-request-id': REQUEST_ID } });
    expect(res.json()).toEqual({ seen: Array<string>(5).fill(REQUEST_ID) });
  });

  it('is seen inside a setTimeout that fires after the reply was sent', async () => {
    let fromTimer: Promise<string | undefined> | undefined;
    const { app } = await buildApp((a) => {
      a.get('/v1/later', async () => {
        fromTimer = new Promise((resolve) => setTimeout(() => resolve(contextId()), 20));
        return 'ok';
      });
    });
    const res = await app.inject({ url: '/v1/later', headers: { 'x-request-id': REQUEST_ID } });
    expect(res.statusCode).toBe(200);
    await expect(fromTimer).resolves.toBe(REQUEST_ID);
  });

  it('keeps concurrent requests apart', async () => {
    const { app } = await buildApp(routes);
    const ids = Array.from(
      { length: 20 },
      (_, i) => `req_01JA3Z8K2M5N7P9Q0R1S2T3V${String(i).padStart(2, '0')}`,
    );
    const responses = await Promise.all(
      ids.map((id) => app.inject({ url: '/v1/async', headers: { 'x-request-id': id } })),
    );
    responses.forEach((res, i) => {
      expect(res.json()).toEqual({ seen: Array<string>(5).fill(ids[i] ?? '') });
    });
  });

  it('is seen by hooks and the handler after the body is parsed', async () => {
    const { app } = await buildApp((a) => {
      a.addHook('preHandler', async (request) => {
        (request as { seenInHook?: string }).seenInHook = contextId();
      });
      a.post('/v1/echo', async (request) => ({
        hook: (request as { seenInHook?: string }).seenInHook,
        handler: contextId(),
        body: request.body,
      }));
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      headers: { 'x-request-id': REQUEST_ID },
      payload: { hello: 'world' },
    });
    expect(res.json()).toEqual({ hook: REQUEST_ID, handler: REQUEST_ID, body: { hello: 'world' } });
  });

  it('survives a body parser that finishes outside it (Fastify re-enters the scope)', async () => {
    const { app } = await buildApp((a) => {
      // A parser that completes from a shared queue drained by a timer created at startup, as a
      // pooled or batching parser would: its callback runs outside the request's async context.
      const queue: (() => void)[] = [];
      const drain = setInterval(() => queue.splice(0).forEach((fn) => fn()), 1);
      drain.unref();
      a.addHook('onClose', (_instance, done) => {
        clearInterval(drain);
        done();
      });
      a.addContentTypeParser('application/x-pooled', (_request, payload, done) => {
        payload.resume();
        payload.on('end', () => queue.push(() => done(null, { pooled: true })));
      });
      a.post('/v1/pooled', async (request) => ({ ctx: contextId(), body: request.body }));
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pooled',
      headers: { 'content-type': 'application/x-pooled', 'x-request-id': REQUEST_ID },
      payload: 'x',
    });
    await app.close();
    expect(res.json()).toEqual({ ctx: REQUEST_ID, body: { pooled: true } });
  });

  it('lets handler code log without passing the id: every line carries request_id', async () => {
    const { app, lines } = await buildApp((a, logger) => {
      a.get('/v1/work', async () => {
        await sleep(1);
        logger.child({ component: 'deep' }).info('doing work');
        return 'ok';
      });
    });
    await app.inject({ url: '/v1/work', headers: { 'x-request-id': REQUEST_ID } });
    expect(lines().find((l) => l['msg'] === 'doing work')).toMatchObject({
      request_id: REQUEST_ID,
    });
  });
});

describe('over a real socket', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const listen = async (): Promise<number> => {
    const built = await buildApp(routes);
    app = built.app;
    await app.listen({ host: '127.0.0.1', port: 0 });
    return (app.server.address() as AddressInfo).port;
  };

  it('the handler sees the context for a body that arrives over the network', async () => {
    const port = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/v1/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': REQUEST_ID },
      body: JSON.stringify({ big: 'x'.repeat(200_000) }),
    });
    const json = (await res.json()) as { ctx: string; body: { big: string } };
    expect(json.ctx).toBe(REQUEST_ID);
    expect(json.body.big).toHaveLength(200_000);
  });

  it('uses the first of two X-Request-Id headers on the wire', async () => {
    const port = await listen();
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      `GET /v1/sessions/ses_1 HTTP/1.1\r\nHost: x\r\nX-Request-Id: ${REQUEST_ID}\r\n` +
        `X-Request-Id: ${OTHER_REQUEST_ID}\r\nConnection: close\r\n\r\n`,
    );
    let response = '';
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
    });
    await once(socket, 'end');
    expect(response).toMatch(new RegExp(`^x-request-id: ${REQUEST_ID}\\r$`, 'im'));
  });
});
