/**
 * Access log (B005 acceptance 4): exactly one line per request with request_id, the route template,
 * status, duration_ms and bytes, never query values, headers or bodies; metrics labelled by route
 * template; and one line for a request the client abandoned.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_CLOSED_STATUS,
  DURATION_BUCKETS_S,
  REQUEST_ID_HEADER,
  UNMATCHED_ROUTE,
} from '../src/plugins/request-context.js';
import { buildApp, recordingMetrics, REQUEST_ID } from './helpers.js';

function routes(app: FastifyInstance): void {
  app.get('/v1/sessions/:id', async (request) => ({ id: (request.params as { id: string }).id }));
  app.post('/v1/sessions/:id/messages', async () => ({ ok: true }));
  app.get('/v1/fail', async () => {
    throw new Error('boom');
  });
}

describe('access log (acceptance 4)', () => {
  it('writes one line with request_id, route template, status, duration_ms and bytes', async () => {
    const { app, access } = await buildApp(routes);
    const res = await app.inject({ url: '/v1/sessions/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W' });
    const lines = access();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'http.request',
      request_id: res.headers[REQUEST_ID_HEADER],
      method: 'GET',
      route: '/v1/sessions/:id',
      status: 200,
      bytes: Number(res.headers['content-length']),
    });
    const duration = lines[0]?.['duration_ms'];
    expect(Number.isInteger(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('never contains query string values, raw paths, headers or bodies', async () => {
    const { app, access, raw } = await buildApp(routes);
    await app.inject({
      method: 'POST',
      url: '/v1/sessions/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W/messages?token=hunter2&q=private-words',
      headers: { authorization: 'Bearer abc', cookie: 'sid=s3cr3t', 'user-agent': 'agent/1.0' },
      payload: { text: 'message body words' },
    });
    expect(access()).toHaveLength(1);
    expect(access()[0]?.['route']).toBe('/v1/sessions/:id/messages');
    const out = raw();
    for (const forbidden of [
      'hunter2',
      'private-words',
      'token=',
      '?',
      'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      'Bearer',
      's3cr3t',
      'agent/1.0',
      'message body words',
    ]) {
      expect(out, forbidden).not.toContain(forbidden);
    }
  });

  it('writes exactly one line per request, each with its own request id', async () => {
    const { app, access } = await buildApp(routes);
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => app.inject({ url: `/v1/sessions/ses_${i}` })),
    );
    const ids = responses.map((r) => r.headers[REQUEST_ID_HEADER]);
    const lines = access();
    expect(lines).toHaveLength(25);
    expect(new Set(lines.map((l) => l['request_id']))).toEqual(new Set(ids));
  });

  it('logs a 404 under a fixed route name and a thrown error as status 500, once each', async () => {
    const { app, access } = await buildApp(routes);
    await app.inject({ url: '/nowhere/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W?x=1' });
    await app.inject({ url: '/v1/fail', headers: { 'x-request-id': REQUEST_ID } });
    expect(access()).toEqual([
      expect.objectContaining({ route: UNMATCHED_ROUTE, status: 404, method: 'GET' }),
      expect.objectContaining({ route: '/v1/fail', status: 500, request_id: REQUEST_ID }),
    ]);
  });

  it('measures duration_ms with the injected clock, rounded to whole milliseconds', async () => {
    const times = [1000, 1012.6];
    const { app, access } = await buildApp(routes, { clock: () => times.shift() ?? 2000 });
    await app.inject({ url: '/v1/sessions/ses_1' });
    expect(access()[0]?.['duration_ms']).toBe(13);
  });

  it('labels metrics with the route template, method and status class only', async () => {
    const { metrics, count, observations } = recordingMetrics();
    const times = [0, 25, 100, 150];
    const { app } = await buildApp(routes, { metrics, clock: () => times.shift() ?? 0 });
    await app.inject({ url: '/v1/sessions/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W?token=x' });
    await app.inject({ url: '/v1/fail' });
    expect(
      count('http_requests_total', {
        method: 'GET',
        route: '/v1/sessions/:id',
        status_class: '2xx',
      }),
    ).toBe(1);
    expect(
      count('http_requests_total', { method: 'GET', route: '/v1/fail', status_class: '5xx' }),
    ).toBe(1);
    expect(observations).toEqual([
      {
        name: 'http_request_duration_seconds',
        value: 0.025,
        labels: { method: 'GET', route: '/v1/sessions/:id' },
      },
      {
        name: 'http_request_duration_seconds',
        value: 0.05,
        labels: { method: 'GET', route: '/v1/fail' },
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain('ses_');
    expect(DURATION_BUCKETS_S).toEqual([...DURATION_BUCKETS_S].sort((a, b) => a - b));
  });
});

describe('abandoned requests', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('a request the client abandons gets one line, status 499, even if the handler replies later', async () => {
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    let replied!: () => void;
    const handlerReplied = new Promise<void>((resolve) => {
      replied = resolve;
    });
    const built = await buildApp((a) => {
      a.get('/v1/slow', async (_request, reply) => {
        started();
        await handlerReleased;
        await reply.send({ late: true });
        replied();
        return reply;
      });
    });
    app = built.app;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`GET /v1/slow?token=x HTTP/1.1\r\nHost: x\r\nX-Request-Id: ${REQUEST_ID}\r\n\r\n`);
    await handlerStarted;
    socket.destroy();

    for (let i = 0; i < 100 && built.access().length === 0; i++) await sleep(5);
    release();
    await handlerReplied;
    await sleep(20);

    expect(built.access()).toEqual([
      expect.objectContaining({
        request_id: REQUEST_ID,
        route: '/v1/slow',
        status: CLIENT_CLOSED_STATUS,
        aborted: true,
      }),
    ]);
    expect(built.raw()).not.toContain('token=x');
  });
});
