/**
 * Creating and revoking share links (B068; tests "share-links.create-revoke.test.ts", acceptance
 * 1 and 6): the host only (an editor is 403 `host_required`, audited); a 43-character base64url
 * token, `expires_at` at most 24 h out (default 1 h, 86 401 s is 422), `max_uses` 1 to 50 (default
 * 10); revoking makes the next join fail and closes the link's guests through the relay notifier
 * in the same request; a notifier that is down does not undo the revoke.
 */
import { describe, expect, it } from 'vitest';
import { shareApp, T0 } from './helpers.js';

describe('create', () => {
  it('the host gets a 43-character token, its URL, and a link that lives 1 h by default', async () => {
    const env = await shareApp();
    const s = await env.session();
    const res = await env.create(s.sid, s.host);
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({
      url: `https://centcom.dev/j/${body.token}`,
      session: s.sid,
      created_at: new Date(T0).toISOString(),
      expires_at: new Date(T0 + 3_600_000).toISOString(),
      revoked_at: null,
      max_uses: 10,
    });
    const audit = await env.detached();
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'invite.create', outcome: 'success' }),
      ]),
    );
  });

  it('expires_in_s 60 to 86 400 and max_uses 1 to 50; anything else is 422', async () => {
    const env = await shareApp();
    const s = await env.session();
    const long = await env.create(s.sid, s.host, { expires_in_s: 86_400, max_uses: 50 });
    expect(long.statusCode).toBe(201);
    expect(Date.parse(long.json().expires_at) - T0).toBe(86_400_000);
    for (const body of [
      { expires_in_s: 86_401 },
      { expires_in_s: 59 },
      { expires_in_s: 1.5 },
      { max_uses: 0 },
      { max_uses: 51 },
    ]) {
      const res = await env.create(s.sid, s.host, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('validation_failed');
    }
  });

  it('an editor is 403 host_required (audited); a stranger 404; an API key 403', async () => {
    const env = await shareApp();
    const s = await env.session();
    const editor = await env.create(s.sid, s.editor);
    expect(editor.statusCode).toBe(403);
    expect(editor.json().code).toBe('host_required');
    const audit = await env.detached();
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'permission.denied', outcome: 'denied' }),
      ]),
    );
    const stranger = await env.create(s.sid, s.w.outsider);
    expect(stranger.statusCode).toBe(404);
    const key = await env.app.inject({
      method: 'POST',
      url: `/v1/sessions/${s.sid}/share-links`,
      headers: env.asKey(s.workspace),
      payload: {},
    });
    expect(key.statusCode).toBe(403);
  });

  it('an ended session is 410', async () => {
    const env = await shareApp();
    const s = await env.session();
    const ended = env.world.sessions.get(s.sid);
    if (ended !== undefined) ended.row.state = 'ended';
    expect((await env.create(s.sid, s.host)).statusCode).toBe(410);
  });
});

describe('revoke', () => {
  it('fails the next join and closes the link’s guests in the same request', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const joined = await env.join(token, { display_name: 'Guest' }, env.ip());
    expect(joined.statusCode).toBe(200);
    const member = joined.json().member;
    const res = await env.revoke(s.sid, token, s.host);
    expect(res.statusCode).toBe(204);
    expect(env.closed).toEqual([{ sid: s.sid, members: [member] }]);
    expect(env.store.guests).toEqual([]);
    expect((await env.join(token, { display_name: 'Late' }, env.ip())).statusCode).toBe(404);
    // Revoking again is fine (nothing left to close); an unknown token is 404.
    expect((await env.revoke(s.sid, token, s.host)).statusCode).toBe(204);
    expect((await env.revoke(s.sid, 'x'.repeat(43), s.host)).statusCode).toBe(404);
  });

  it('a non-host is 403; the link keeps working', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    const res = await env.revoke(s.sid, token, s.editor);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('host_required');
    expect((await env.join(token, { display_name: 'Guest' }, env.ip())).statusCode).toBe(200);
  });

  it('the relay notifier down: the revoke stands, guests are gone, the failure is counted', async () => {
    const env = await shareApp();
    const s = await env.session();
    const { token } = (await env.create(s.sid, s.host)).json();
    await env.join(token, { display_name: 'Guest' }, env.ip());
    env.shareFlags.failNotifier = true;
    expect((await env.revoke(s.sid, token, s.host)).statusCode).toBe(204);
    expect(env.store.guests).toEqual([]);
    expect(env.recorded.count('share_link_close_failed_total')).toBe(1);
    expect((await env.join(token, { display_name: 'Late' }, env.ip())).statusCode).toBe(404);
  });
});
