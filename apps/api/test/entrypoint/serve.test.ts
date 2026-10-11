/** Listening and stopping (B102): a request in flight finishes, new connections are refused, the pools close. */
import { fastify } from 'fastify';
import { describe, expect, it } from 'vitest';
import { serve } from '../../src/serve.js';
import { captureLogger } from '../helpers.js';

describe('serve (B102)', () => {
  it('lets a request in flight finish, refuses new connections, closes the backends and answers 0', async () => {
    const { logger } = captureLogger();
    const app = fastify({ logger: false });
    app.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return { done: true };
    });
    let closed = false;
    const server = await serve(app, {
      host: '127.0.0.1',
      port: 0,
      logger,
      closeBackends: async () => {
        closed = true;
      },
    });
    const inFlight = fetch(`${server.address}/slow`, { keepalive: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stopped = server.stop('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fetch(`${server.address}/slow`, { keepalive: false })).rejects.toThrow();
    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ done: true });
    expect(await stopped).toBe(0);
    expect(closed).toBe(true);
    expect(await server.stop('SIGINT')).toBe(0);
  }, 15_000);

  it('gives up with 1 when requests do not finish within the grace period', async () => {
    const { logger } = captureLogger();
    const app = fastify({ logger: false });
    app.get('/stuck', () => new Promise(() => undefined));
    const server = await serve(app, {
      host: '127.0.0.1',
      port: 0,
      logger,
      closeBackends: async () => undefined,
      graceMs: 300,
    });
    void fetch(`${server.address}/stuck`, { keepalive: false }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await server.stop('SIGTERM')).toBe(1);
  }, 10_000);
});
