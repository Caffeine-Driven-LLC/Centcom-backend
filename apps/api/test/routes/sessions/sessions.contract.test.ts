/**
 * Response bodies against the generated CT-API-SESSIONS schemas (B054; test
 * "sessions.contract.test.ts", acceptance 8 and 9's headers):
 *
 * - `SessionCreated`, `Session`, `SessionPage`, `JoinToken`, `SessionMemberPage` validate against
 *   `packages/contracts`; every error is a `Problem`;
 * - every answer carries `X-Request-Id` and the `RateLimit-*` headers;
 * - the members list shows exactly the registered public keys of each member's device, sorted by
 *   join order, and nothing private or sealed.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { sessionsApp, World } from './helpers.js';

async function setup() {
  const world = new World();
  const w = world.workspace('team');
  const env = await sessionsApp({ world });
  return { ...env, w };
}

const expectHeaders = (headers: Record<string, unknown>): void => {
  expect(headers['x-request-id']).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(headers['ratelimit-limit']).toBeDefined();
  expect(headers['ratelimit-remaining']).toBeDefined();
  expect(headers['ratelimit-reset']).toBeDefined();
};

describe('bodies', () => {
  it('validates every success body against its schema', async () => {
    const env = await setup();
    const created = await env.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: await env.as(env.w.owner),
      payload: { workspace: env.w.id, name: 'Contract', policy: { auto_failover: true } },
    });
    expect(created.statusCode).toBe(201);
    expect(validate('api/SessionCreated', created.json()).ok).toBe(true);
    expectHeaders(created.headers);
    const sid = created.json<{ id: string }>().id;

    const calls: {
      method: 'GET' | 'POST' | 'PATCH';
      url: string;
      schema: string;
      payload?: object;
    }[] = [
      { method: 'GET', url: `/v1/sessions?workspace=${env.w.id}`, schema: 'api/SessionPage' },
      { method: 'GET', url: '/v1/sessions', schema: 'api/SessionPage' },
      { method: 'GET', url: `/v1/sessions/${sid}`, schema: 'api/Session' },
      {
        method: 'PATCH',
        url: `/v1/sessions/${sid}`,
        schema: 'api/Session',
        payload: { name: 'C2' },
      },
      {
        method: 'POST',
        url: `/v1/sessions/${sid}/join-token`,
        schema: 'api/JoinToken',
        payload: {},
      },
      { method: 'GET', url: `/v1/sessions/${sid}/members`, schema: 'api/SessionMemberPage' },
      { method: 'POST', url: `/v1/sessions/${sid}/claim-host`, schema: 'api/Session' },
      { method: 'POST', url: `/v1/sessions/${sid}/end`, schema: 'api/Session' },
    ];
    for (const call of calls) {
      const res = await env.app.inject({
        method: call.method,
        url: call.url,
        headers: await env.as(env.w.owner),
        ...(call.payload === undefined ? {} : { payload: call.payload }),
      });
      expect(res.statusCode, call.url).toBe(200);
      const result = validate(call.schema as 'api/Session', res.json());
      expect(result.ok, `${call.method} ${call.url}: ${JSON.stringify(result)}`).toBe(true);
      expectHeaders(res.headers);
    }
  });

  it('answers errors as Problem bodies with the same headers', async () => {
    const env = await setup();
    const res = await env.app.inject({
      method: 'GET',
      url: '/v1/sessions/ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      headers: await env.as(env.w.owner),
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(validate('problem', res.json()).ok).toBe(true);
    expectHeaders(res.headers);
  });
});

describe('members', () => {
  it('shows exactly the registered public keys, in join order, and nothing private', async () => {
    const env = await setup();
    const { id: sid } = await env.create(env.w.owner, env.w.id);
    for (const who of [env.w.member, env.w.admin]) {
      await env.app.inject({
        method: 'POST',
        url: `/v1/sessions/${sid}/join-token`,
        headers: await env.as(who),
        payload: {},
      });
    }
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${sid}/members`,
      headers: await env.as(env.w.member),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        user: string;
        join_order: number;
        slot: number;
        role: string;
        device_keys: Record<string, unknown>;
      }[];
    }>();
    expect(body.data.map((m) => m.user)).toEqual([
      env.w.owner.user,
      env.w.member.user,
      env.w.admin.user,
    ]);
    expect(body.data.map((m) => m.join_order)).toEqual([1, 2, 3]);
    expect(body.data.map((m) => m.slot)).toEqual([0, 1, 2]);
    expect(body.data.map((m) => m.role)).toEqual(['host', 'editor', 'editor']);
    for (const [i, who] of [env.w.owner, env.w.member, env.w.admin].entries()) {
      const device = env.world.devices.get(who.device);
      expect(body.data[i]?.device_keys).toEqual({
        device: who.device,
        x25519: device?.x25519,
        ed25519: device?.ed25519,
        fingerprint: device?.fingerprint,
        revoked: false,
      });
    }
    expect(res.body).not.toMatch(/private|sealed|"d"|secret/i);
  });
});
