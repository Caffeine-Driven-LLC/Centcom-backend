/**
 * The credential-leak guard mounted on a real Fastify instance (B101): the preValidation hook
 * rejects a body with a credential before the handler runs, with the generic problem and nothing
 * of the value in the response, logs or metric labels; a clean body passes; a telemetry route
 * built on `guardTelemetryBatch` keeps answering 204.
 */
import { newId, validateProblem } from '@centcom/contracts';
import { createLogger, secretGuard } from '@centcom/core';
import { fastify } from 'fastify';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

const BEARER = ['Authorization: ', 'Bearer ', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
const AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

function build() {
  const written: string[] = [];
  const labels: string[] = [];
  const logger = createLogger({
    level: 'trace',
    service: 'api',
    version: '1',
    env: 'test',
    destination: new Writable({
      write(chunk, _enc, cb) {
        written.push(String(chunk));
        cb();
      },
    }),
  });
  const metrics = {
    counter: (name: string, l?: Readonly<Record<string, string>>) => ({
      inc: () => void labels.push(`${name}${JSON.stringify(l ?? {})}`),
    }),
    histogram: () => ({ observe: () => undefined }),
  };
  const app = fastify();
  const handled: unknown[] = [];
  app.addHook('preValidation', secretGuard.secretGuardHook({ logger, metrics }));
  app.post('/v1/echo', async (request) => {
    handled.push(request.body);
    return { ok: true };
  });
  return { app, written, labels, handled };
}

describe('secretGuardHook on Fastify', () => {
  it('rejects a body with a Bearer line: 400 invalid_request, handler not called, no value anywhere', async () => {
    const { app, written, labels, handled } = build();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      headers: { 'x-request-id': newId('req') },
      payload: { note: BEARER },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      status: 400,
      code: 'invalid_request',
      detail: 'request rejected',
    });
    expect(validateProblem(body).ok).toBe(true);
    expect(handled).toEqual([]);
    const everything = [res.body, ...written, ...labels].join('\n');
    expect(everything).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(labels).toEqual(['secret_guard_hits_total{"surface":"rest","pattern":"bearer_header"}']);
    await app.close();
  });

  it('lets an identical clean body through with 200', async () => {
    const { app, handled } = build();
    const res = await app.inject({ method: 'POST', url: '/v1/echo', payload: { note: 'hello' } });
    expect(res.statusCode).toBe(200);
    expect(handled).toEqual([{ note: 'hello' }]);
    await app.close();
  });

  it('keeps answering 204 when a telemetry batch has a bad event', async () => {
    const events: unknown[] = Array.from({ length: 100 }, (_, i) => ({ name: 'x', n: i }));
    events[7] = { name: 'x', note: AWS };
    const seen: number[] = [];
    const app = fastify();
    app.post('/v1/telemetry', async (request, reply) => {
      const out = secretGuard.guardTelemetryBatch((request.body as { events: unknown[] }).events);
      seen.push(out.clean.length, out.rejected);
      return reply.code(204).send();
    });
    const res = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: { events } });
    expect(res.statusCode).toBe(204);
    expect(seen).toEqual([99, 1]);
    await app.close();
  });
});
