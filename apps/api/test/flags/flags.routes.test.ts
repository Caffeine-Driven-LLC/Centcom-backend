/**
 * `GET /v1/flags` (B083) on the API's plugin stack with real B017 tokens:
 *
 * - authz: anonymous callers get public, fully on-or-off flags only; a user token with `profile`
 *   gets its personal set (rollout by its `usr_` id, its plan and workspace); an API key, or a
 *   token without `profile`, gets the anonymous set; a bad credential is 401;
 * - ETag and 304: the same caller gets the same ETag, `If-None-Match` with it is 304 without a
 *   body, and after a change `rev` is one higher and the ETag new;
 * - headers: `public, max-age=30` anonymous, `private, max-age=<FLAGS_TTL_S>` authenticated,
 *   `Vary: Authorization, User-Agent`;
 * - version targeting from the User-Agent;
 * - contract: the body is CT-API-FLAGS `Flags`, with keys and values only.
 */
import { newId, validate } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { bucketOf } from '../../src/modules/flags/bucket.js';
import { boolFlag, flagsWorld, getFlags, staff, type FlagsWorld } from './helpers.js';

let world: FlagsWorld;
afterEach(async () => {
  await world.close();
});

const CLI = (version: string) => ({
  'user-agent': `centcom-cli/${version} (contract/1.0.0; linux-x64; node/22.9.0)`,
});

/** A user id inside (or outside) a `percent` rollout of `key`. */
function userIn(key: string, percent: number, inside: boolean): string {
  for (;;) {
    const id = newId('usr');
    if (bucketOf(key, id) < percent * 100 === inside) return id;
  }
}

describe('who gets what', () => {
  it('serves anonymous callers, users, and API keys their own sets', async () => {
    world = flagsWorld();
    const ws = newId('wsp');
    const { app, admin } = await world.instance();
    await admin.setFlag(boolFlag('banner', { public: true }), staff);
    await admin.setFlag(
      boolFlag('beta.rollout', { public: true, rules: [{ type: 'percent', percent: 50 }] }),
      staff,
    );
    await admin.setFlag(
      boolFlag('team.tools', { rules: [{ type: 'plans', plans: ['team'] }] }),
      staff,
    );
    await admin.setFlag(
      boolFlag('ws.pilot', { rules: [{ type: 'workspaces', workspaces: [ws] }] }),
      staff,
    );
    await admin.setFlag(boolFlag('ops.only', { server_only: true }), staff);
    await admin.setFlag(
      { key: 'limits', type: 'json', value: { queue: 50 }, default: { queue: 10 } },
      staff,
    );

    const anonymous = await getFlags(app);
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ flags: { banner: true }, rev: 6, ttl_s: 30 });
    expect(anonymous.headers['cache-control']).toBe('public, max-age=30');
    expect(anonymous.headers['vary']).toBe('Authorization, User-Agent');

    const inside = userIn('beta.rollout', 50, true);
    const member = await getFlags(
      app,
      await world.userToken({ userId: inside, plan: 'team', workspaceId: ws }),
    );
    expect(member.json()).toEqual({
      flags: {
        banner: true,
        'beta.rollout': true,
        limits: { queue: 50 },
        'team.tools': true,
        'ws.pilot': true,
      },
      rev: 6,
      ttl_s: 60,
    });
    expect(member.headers['cache-control']).toBe('private, max-age=60');
    expect(member.headers['vary']).toBe('Authorization, User-Agent');

    const outside = userIn('beta.rollout', 50, false);
    const other = await getFlags(app, await world.userToken({ userId: outside }));
    expect(other.json<{ flags: unknown }>().flags).toEqual({
      banner: true,
      'beta.rollout': false,
      limits: { queue: 50 },
      'team.tools': false,
      'ws.pilot': false,
    });

    // Machine principals and tokens without `profile` have no user: the anonymous set, privately.
    for (const headers of [
      world.apiKey(ws),
      await world.userToken({ scopes: ['workspaces:read'] }),
    ]) {
      const res = await getFlags(app, headers);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ flags: unknown }>().flags).toEqual({ banner: true });
      expect(res.headers['cache-control']).toBe('private, max-age=60');
    }
  });

  it('refuses a bad credential with 401, and never answers flags with it', async () => {
    world = flagsWorld();
    const { app } = await world.instance();
    for (const authorization of [
      'Bearer not-a-token',
      'Basic dXNlcjpwYXNz',
      'Bearer cen_test_unknownkey',
    ]) {
      const res = await getFlags(app, { authorization });
      expect(res.statusCode, authorization).toBe(401);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      expect(validate('problem', res.json()).ok).toBe(true);
      expect(res.json<{ code: string }>().code).toMatch(/^(unauthorized|token_invalid)$/);
    }
  });
});

describe('ETag and 304', () => {
  it('answers 304 to the current ETag, then a new ETag and rev + 1 after a change', async () => {
    world = flagsWorld();
    const { app, admin } = await world.instance();
    await admin.setFlag(boolFlag('banner', { public: true }), staff);
    const headers = await world.userToken();
    const first = await getFlags(app, headers);
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^"f1\.[A-Za-z0-9_-]{16}"$/);
    expect((await getFlags(app, headers)).headers['etag']).toBe(etag);

    const cached = await getFlags(app, { ...headers, 'if-none-match': etag });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    expect(cached.headers['etag']).toBe(etag);
    expect(cached.headers['cache-control']).toBe('private, max-age=60');
    expect((await getFlags(app, { ...headers, 'if-none-match': `W/${etag}` })).statusCode).toBe(
      304,
    );
    expect((await getFlags(app, { ...headers, 'if-none-match': '"f0.nope"' })).statusCode).toBe(
      200,
    );

    for (const change of [
      () => admin.setFlag(boolFlag('banner', { public: true, kill: true }), staff),
      () => admin.setFlag(boolFlag('second'), staff),
      () => admin.deleteFlag('second', staff),
    ]) {
      const before = (await getFlags(app, headers)).json<{ rev: number }>().rev;
      const { rev } = await change();
      expect(rev).toBe(before + 1);
      const after = await getFlags(app, { ...headers, 'if-none-match': etag });
      expect(after.statusCode).toBe(200);
      expect(after.json<{ rev: number }>().rev).toBe(before + 1);
      expect(after.headers['etag']).not.toBe(etag);
    }
    // Callers who see different flags get different ETags; anonymous callers share one.
    const anon = [await getFlags(app), await getFlags(app)];
    expect(anon[0]?.headers['etag']).toBe(anon[1]?.headers['etag']);
    expect(anon[0]?.headers['etag']).not.toBe((await getFlags(app, headers)).headers['etag']);
  });
});

describe('client versions', () => {
  it('shows a min_client_version 1.2.0 flag to centcom-cli/1.2.0, not to 1.1.9 or unknown clients', async () => {
    world = flagsWorld();
    const { app, admin } = await world.instance();
    await admin.setFlag(
      boolFlag('new.sync', { public: true, rules: [{ type: 'client_version', min: '1.2.0' }] }),
      staff,
    );
    await admin.setFlag(boolFlag('plain', { public: true }), staff);
    const user = await world.userToken();
    for (const headers of [{}, user]) {
      const keys = async (ua: Record<string, string>) =>
        Object.keys((await getFlags(app, { ...headers, ...ua })).json<{ flags: object }>().flags);
      expect(await keys(CLI('1.1.9'))).toEqual(['plain']);
      expect(await keys(CLI('1.2.0'))).toEqual(['new.sync', 'plain']);
      expect(await keys(CLI('3.0.0-rc.1'))).toEqual(['new.sync', 'plain']);
      expect(await keys({ 'user-agent': 'curl/8.4.0' })).toEqual(['plain']);
      expect(await keys({ 'user-agent': 'centcom-cli/garbage' })).toEqual(['plain']);
      expect(await keys({})).toEqual(['plain']);
    }
  });
});

describe('contract', () => {
  it('answers CT-API-FLAGS Flags with keys and values only, never rules or server_only flags', async () => {
    world = flagsWorld();
    const ws = newId('wsp');
    const { app, admin } = await world.instance();
    await admin.setFlag(
      { key: 'theme', type: 'string', value: 'dark', default: 'light', public: true },
      staff,
    );
    await admin.setFlag({ key: 'max.agents', type: 'number', value: 8, default: 2 }, staff);
    await admin.setFlag(
      boolFlag('pilot', {
        rules: [
          { type: 'workspaces', workspaces: [ws] },
          { type: 'percent', percent: 25 },
          { type: 'plans', plans: ['pro'] },
        ],
      }),
      staff,
    );
    await admin.setFlag(boolFlag('ops.kill_relay', { server_only: true }), staff);
    for (const headers of [{}, await world.userToken({ plan: 'pro', workspaceId: ws })]) {
      const res = await getFlags(app, headers);
      const checked = validate('api/Flags', res.json());
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      expect(Object.keys(res.json<object>()).sort()).toEqual(['flags', 'rev', 'ttl_s']);
      expect(res.body).not.toMatch(
        /percent|plans|workspaces|wsp_|rules|ops\.kill_relay|server_only|usr_/,
      );
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['etag']).toBeDefined();
    }
  });
});
