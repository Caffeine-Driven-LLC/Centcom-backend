/**
 * Surface 2a, REST (B101): the hook rejects a request that carries a credential with the same
 * generic 400 whatever the pattern, never calls the handler, never repeats the value, passes a
 * clean request and the service's own Authorization header, and fails closed.
 */
import { describe, expect, it } from 'vitest';
import { newId } from '@centcom/contracts';
import { createLogger } from '../../log/logger.js';
import { captureStream, recordingMetrics } from '../../../test/log/helpers.js';
import { createAllowList } from '../allow.js';
import {
  REJECTION_DETAIL,
  secretGuardHook,
  type GuardReply,
  type GuardRequest,
} from '../fastify.js';
import { ANTHROPIC_KEY, AWS_KEY, BEARER_LINE, JWT } from '../../../test/secret-guard/helpers.js';

function fakeReply() {
  const sent: { status: number; headers: Record<string, string>; body: string }[] = [];
  const reply: GuardReply & { sent: typeof sent } = {
    sent,
    code(status) {
      sent.push({ status, headers: {}, body: '' });
      return reply;
    },
    header(name, value) {
      const last = sent[sent.length - 1];
      if (last) last.headers[name] = value;
      return reply;
    },
    send(payload) {
      const last = sent[sent.length - 1];
      if (last) last.body = String(payload);
      return reply;
    },
  };
  return reply;
}

const request = (over: Partial<GuardRequest> = {}): GuardRequest => ({
  id: newId('req'),
  headers: {},
  routeOptions: { url: '/v1/things' },
  ...over,
});

function setup(options: Parameters<typeof secretGuardHook>[0] = {}) {
  const out = captureStream();
  const logger = createLogger({
    level: 'trace',
    service: 'api',
    version: '1',
    env: 'test',
    destination: out.stream,
  });
  const m = recordingMetrics();
  return { hook: secretGuardHook({ logger, metrics: m.metrics, ...options }), ...out, ...m };
}

describe('secretGuardHook', () => {
  it('rejects a body that holds a Bearer line with the generic problem, and leaves nothing behind', async () => {
    const { hook, raw, count } = setup();
    const reply = fakeReply();
    const out = await hook(request({ body: { note: BEARER_LINE } }), reply);
    expect(out).toBe(reply);
    const [res] = reply.sent;
    expect(res?.status).toBe(400);
    expect(res?.headers['content-type']).toBe('application/problem+json');
    const problem = JSON.parse(res?.body ?? '{}') as Record<string, unknown>;
    expect(problem).toMatchObject({
      status: 400,
      code: 'invalid_request',
      detail: REJECTION_DETAIL,
    });
    expect(problem['request_id']).toMatch(/^req_/);
    expect(res?.body).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(raw().join('\n')).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(raw().join('\n')).toContain('secret_guard_hit');
    expect(count('secret_guard_hits_total', { surface: 'rest', pattern: 'bearer_header' })).toBe(1);
  });

  it('answers identically for every pattern (no oracle)', async () => {
    const { hook } = setup();
    const bodies: string[] = [];
    for (const secret of [ANTHROPIC_KEY, AWS_KEY, BEARER_LINE, JWT]) {
      const reply = fakeReply();
      await hook(request({ id: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W', body: { x: secret } }), reply);
      bodies.push(reply.sent[0]?.body ?? '');
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("passes a clean body and the service's own Authorization header", async () => {
    const { hook } = setup();
    const reply = fakeReply();
    const out = await hook(
      request({
        body: { name: 'plan' },
        headers: { authorization: `Bearer ${JWT}`, accept: 'application/json' },
      }),
      reply,
    );
    expect(out).toBeUndefined();
    expect(reply.sent).toEqual([]);
  });

  it('scans the query, the path parameters, other headers, and a raw text or Buffer body', async () => {
    const { hook } = setup();
    for (const over of [
      { query: { q: AWS_KEY } },
      { params: { id: AWS_KEY } },
      { headers: { 'x-note': AWS_KEY } },
      { headers: { cookie: [AWS_KEY] } },
      { body: `hello ${AWS_KEY}` },
      { body: Buffer.from(`hello ${AWS_KEY}`) },
    ] as Partial<GuardRequest>[]) {
      const reply = fakeReply();
      expect(await hook(request(over), reply)).toBe(reply);
      expect(reply.sent[0]?.status).toBe(400);
    }
  });

  it('honours a route-scoped allow-list entry and nothing broader', async () => {
    const allow = createAllowList({
      entries: [
        {
          pattern_id: 'aws_access_key',
          scope: 'route',
          value: '/v1/docs',
          reason: 'docs',
          expires: '2999-01-01',
        },
      ],
    });
    const { hook } = setup({ allow });
    const ok = fakeReply();
    expect(
      await hook(request({ routeOptions: { url: '/v1/docs' }, body: { t: AWS_KEY } }), ok),
    ).toBeUndefined();
    const no = fakeReply();
    expect(await hook(request({ body: { t: AWS_KEY } }), no)).toBe(no);
  });

  it('fails closed: a body it cannot walk is rejected, and a slow or huge one answers 413', async () => {
    const { hook } = setup({ maxBodyBytes: 2_048 });
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = { n: deep };
    const a = fakeReply();
    await hook(request({ body: deep }), a);
    expect(a.sent[0]?.status).toBe(400);
    const b = fakeReply();
    await hook(request({ body: 'a'.repeat(4_096) }), b);
    expect(b.sent[0]?.status).toBe(413);
    const c = fakeReply();
    await hook(request({ body: new Array<string>(60_000).fill('some ordinary words') }), c);
    expect(c.sent[0]?.status).toBe(413);
  });

  it('does nothing when disabled', async () => {
    const { hook } = setup({ enabled: false });
    expect(await hook(request({ body: { x: AWS_KEY } }), fakeReply())).toBeUndefined();
  });
});
