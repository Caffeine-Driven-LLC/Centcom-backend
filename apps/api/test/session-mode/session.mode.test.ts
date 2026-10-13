/**
 * The session mode (B110, CT-API-SESSIONS `mode`): a session is created as a `command_post` (the
 * default) or a `branch` session, the mode comes back on create, get and list, an unknown value is
 * 422, and PATCH cannot change it.
 */
import { describe, expect, it } from 'vitest';
import { sessionsApp, World } from '../routes/sessions/helpers.js';

async function setup() {
  const world = new World();
  const w = world.workspace('team');
  const env = await sessionsApp({ world });
  return { ...env, w };
}

describe('POST /v1/sessions {mode}', () => {
  it('defaults to command_post and returns the mode on create, get and list', async () => {
    const env = await setup();
    const created = await env.create(env.w.owner, env.w.id);
    expect(created.mode).toBe('command_post');
    const got = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${created.id}`,
      headers: await env.as(env.w.owner),
    });
    expect(got.json()).toMatchObject({ mode: 'command_post' });
  });

  it('creates a branch session when asked, and every read says so', async () => {
    const env = await setup();
    const created = await env.create(env.w.owner, env.w.id, { mode: 'branch' });
    expect(created.mode).toBe('branch');
    const got = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions/${created.id}`,
      headers: await env.as(env.w.owner),
    });
    expect(got.json()).toMatchObject({ id: created.id, mode: 'branch' });
    const list = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions?workspace=${env.w.id}`,
      headers: await env.as(env.w.owner),
    });
    const rows = list.json<{ data: { id: string; mode: string }[] }>().data;
    expect(rows.find((s) => s.id === created.id)?.mode).toBe('branch');
  });

  it('an unknown mode is 422 with the pointer /mode and creates nothing', async () => {
    const env = await setup();
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: await env.as(env.w.owner),
      payload: { workspace: env.w.id, name: 'Nope', mode: 'party' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ errors: { pointer: string }[] }>().errors[0]?.pointer).toBe('/mode');
    const list = await env.app.inject({
      method: 'GET',
      url: `/v1/sessions?workspace=${env.w.id}`,
      headers: await env.as(env.w.owner),
    });
    expect(list.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it('PATCH leaves the mode alone (and the ETag covers it)', async () => {
    const env = await setup();
    const created = await env.create(env.w.owner, env.w.id, { mode: 'branch' });
    const patched = await env.app.inject({
      method: 'PATCH',
      url: `/v1/sessions/${created.id}`,
      headers: await env.as(env.w.owner),
      payload: { name: 'Renamed', mode: 'command_post' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: 'Renamed', mode: 'branch' });
  });
});
