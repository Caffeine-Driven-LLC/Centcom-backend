/**
 * The account lifecycle routes (B026; tests "account-lifecycle.routes.test.ts"), on the real auth
 * and idempotency plugins over the in-memory store:
 *
 * - DELETE /v1/me: 202 with the deadline at now + 30 d; every refresh token and device revoked, and
 *   an access token issued before it refused with `device_revoked` at once (acceptance 1); a second
 *   request keeps the first deadline (2); the only owner of a workspace with other members gets
 *   409 and nothing changes, the sole member of one is scheduled (3).
 * - POST /v1/me/export: an Idempotency-Key replay returns the same export, another export within
 *   24 h is 429 with Retry-After (4); another user's export is 404 and a ready one carries a URL
 *   valid for 900 s (5).
 * - POST /v1/me/restore: 200 with the User, then 409; after the deadline 410 (9).
 * - Responses validate against the generated CT-API-ACCOUNTS validators.
 */
import { newId, validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { toApiUser } from '../../src/modules/me/service.js';
import { bearer, DAY_MS, lifecycleApp } from './helpers.js';

const SECOND = 1000;

describe('DELETE /v1/me', () => {
  it('schedules the deletion 30 days out and kills every token at once (acceptance 1)', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const phone = h.addDevice(user.id);
    const laptop = await h.signIn(user.id, deviceId);
    const other = await h.signIn(user.id, phone);

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(laptop.access_token),
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers['location']).toBe('/v1/me');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ status: string; scheduled_for: string; grace_days: number }>();
    expect(validate('api/AccountDeletion', body).ok).toBe(true);
    expect(body.status).toBe('pending_deletion');
    expect(body.grace_days).toBe(30);
    const expected = h.clock.now() + 30 * DAY_MS;
    expect(Math.abs(Date.parse(body.scheduled_for) - expected)).toBeLessThanOrEqual(SECOND);
    const stored = h.store.users.get(user.id);
    expect(stored?.status).toBe('pending_deletion');
    expect(stored?.deletion_scheduled_at?.getTime()).toBe(expected);
    // GET /v1/me (B022) shows the same deadline.
    expect(stored === undefined ? null : toApiUser(stored).deletion_scheduled_for).toBe(
      body.scheduled_for,
    );
    expect(h.store.refreshRevoked.has(user.id)).toBe(true);
    expect(h.store.devices.every((d) => d.revokedAt !== null)).toBe(true);
    expect(h.jobs.calls.purges).toEqual([{ userId: user.id, at: new Date(expected) }]);
    expect(h.emitter.events.map((e) => e.action)).toEqual(['account.delete_request']);

    // Within 1 s (no time passes here): both devices' access tokens are refused.
    for (const token of [laptop.access_token, other.access_token]) {
      const after = await h.app.inject({
        method: 'POST',
        url: '/v1/me/export',
        headers: bearer(token),
      });
      expect(after.statusCode).toBe(401);
      expect(after.json()).toMatchObject({ code: 'device_revoked' });
    }
    // And the refresh tokens no longer refresh.
    await expect(
      h.tokens.refresh({ refreshToken: laptop.refresh_token, clientId: 'centcom-cli' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/device_revoked|invalid_grant/) });
    await h.app.close();
  });

  it('keeps the first deadline when asked again (acceptance 2)', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const first = await h.signIn(user.id, deviceId);
    const one = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(first.access_token),
    });
    expect(one.statusCode).toBe(202);

    // A day later the user signs in on a new device and asks again.
    h.clock.advance(DAY_MS);
    const laptop = h.addDevice(user.id);
    const again = await h.signIn(user.id, laptop);
    const two = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(again.access_token),
    });
    expect(two.statusCode).toBe(202);
    expect(two.json<{ scheduled_for: string }>().scheduled_for).toBe(
      one.json<{ scheduled_for: string }>().scheduled_for,
    );
    // The new device is revoked too, but the purge is scheduled once and audited once.
    expect(h.store.devices.find((d) => d.id === laptop)?.revokedAt).not.toBeNull();
    expect(h.jobs.calls.purges).toHaveLength(1);
    expect(h.emitter.events).toHaveLength(1);
    await h.app.close();
  });

  it('refuses the only owner of a workspace with other members (acceptance 3)', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const teammate = h.store.addUser({ email: 'bo@example.test' });
    const shared = newId('wsp');
    h.store.join(shared, user.id, 'owner');
    h.store.join(shared, teammate.id, 'member');
    const tokens = await h.signIn(user.id, deviceId);

    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(tokens.access_token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'conflict' });
    expect(h.store.users.get(user.id)?.status).toBe('active');
    expect(h.store.devices.every((d) => d.revokedAt === null)).toBe(true);
    expect(h.jobs.calls.purges).toEqual([]);
    expect(h.emitter.events).toEqual([]);
    // The token still works: nothing was revoked.
    const still = await h.app.inject({
      method: 'GET',
      url: `/v1/me/export/${newId('exp')}`,
      headers: bearer(tokens.access_token),
    });
    expect(still.statusCode).toBe(404);

    // With a second owner the user may go.
    h.store.join(shared, h.store.addUser({ email: 'cy@example.test' }).id, 'owner');
    const ok = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(tokens.access_token),
    });
    expect(ok.statusCode).toBe(202);
    await h.app.close();
  });

  it('schedules the sole member of a workspace (the purge removes it)', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    h.store.join(newId('wsp'), user.id, 'owner');
    const tokens = await h.signIn(user.id, deviceId);
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(tokens.access_token),
    });
    expect(res.statusCode).toBe(202);
    expect(h.store.users.get(user.id)?.status).toBe('pending_deletion');
    await h.app.close();
  });

  it('answers 202 even when Redis or the queue fail after the commit, and counts it', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const tokens = await h.signIn(user.id, deviceId);
    h.jobs.state.fail = true;
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(tokens.access_token),
    });
    expect(res.statusCode).toBe(202);
    expect(
      h.recorded.count('account_lifecycle_after_commit_failures_total', {
        step: 'schedule_purge',
      }),
    ).toBe(1);
    await h.app.close();
  });

  it('answers 503 with retry_after_s when the database is unreachable', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const tokens = await h.signIn(user.id, deviceId);
    h.store.failure = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const res = await h.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(tokens.access_token),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service_unavailable', retry_after_s: 1 });
    await h.app.close();
  });
});

describe('POST /v1/me/restore', () => {
  it('restores within the grace period, then 409, and 410 after it (acceptance 9)', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const before = await h.signIn(user.id, deviceId);
    await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: bearer(before.access_token) });

    // The user signs in again (a new device) during the grace period.
    h.clock.advance(5 * DAY_MS);
    const tokens = await h.signIn(user.id, h.addDevice(user.id));
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/me/restore',
      headers: bearer(tokens.access_token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; deletion_scheduled_for: string | null }>();
    expect(validate('api/User', body).ok).toBe(true);
    expect(body).toMatchObject({ id: user.id, deletion_scheduled_for: null });
    expect(h.jobs.calls.cancels).toEqual([user.id]);
    expect(h.emitter.events.map((e) => e.action)).toEqual([
      'account.delete_request',
      'account.restore',
    ]);

    const twice = await h.app.inject({
      method: 'POST',
      url: '/v1/me/restore',
      headers: bearer(tokens.access_token),
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ code: 'conflict' });

    // Delete again and let the deadline pass.
    await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: bearer(tokens.access_token) });
    h.clock.advance(30 * DAY_MS + SECOND);
    const late = await h.signIn(user.id, h.addDevice(user.id));
    const gone = await h.app.inject({
      method: 'POST',
      url: '/v1/me/restore',
      headers: bearer(late.access_token),
    });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ code: 'gone' });
    expect(h.store.users.get(user.id)?.status).toBe('pending_deletion');
    await h.app.close();
  });

  it('cancelDeletion (for sign-in flows) clears the schedule and removes the purge job', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const tokens = await h.signIn(user.id, deviceId);
    await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: bearer(tokens.access_token) });
    await h.service.cancelDeletion(user.id);
    expect(h.store.users.get(user.id)).toMatchObject({
      status: 'active',
      deletion_scheduled_at: null,
    });
    expect(h.jobs.calls.cancels).toEqual([user.id]);
    // Nothing pending: a second call does nothing.
    await h.service.cancelDeletion(user.id);
    expect(h.jobs.calls.cancels).toEqual([user.id]);
    await h.app.close();
  });
});

describe('POST /v1/me/export and GET /v1/me/export/{id}', () => {
  it('replays a repeated key and limits exports to one per 24 hours (acceptance 4)', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const tokens = await h.signIn(user.id, deviceId);
    const key = newId('req').slice(4);
    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(tokens.access_token, key),
    });
    expect(first.statusCode).toBe(202);
    const created = first.json<{ id: string; status: string }>();
    expect(validate('api/DataExport', created).ok).toBe(true);
    expect(created.status).toBe('pending');
    expect(first.headers['location']).toBe(`/v1/me/export/${created.id}`);
    expect(h.jobs.calls.exports).toEqual([created.id]);

    const replay = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(tokens.access_token, key),
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json<{ id: string }>().id).toBe(created.id);
    expect(h.store.exports.size).toBe(1);

    h.clock.advance(60 * 60 * 1000);
    const fresh = await h.signIn(user.id, deviceId);
    const other = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(fresh.access_token, newId('req').slice(4)),
    });
    expect(other.statusCode).toBe(429);
    expect(other.json()).toMatchObject({ code: 'rate_limited', retry_after_s: 23 * 60 * 60 });
    expect(other.headers['retry-after']).toBe(String(23 * 60 * 60));

    // Once the window has passed, another export is allowed.
    h.clock.advance(23 * 60 * 60 * 1000 + SECOND);
    const next = await h.signIn(user.id, deviceId);
    const later = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(next.access_token),
    });
    expect(later.statusCode).toBe(202);
    await h.app.close();
  });

  it("hides another user's export and signs a 900 s URL for a ready one (acceptance 5)", async () => {
    const h = await lifecycleApp();
    const alice = h.addUser({ email: 'alice@example.test' });
    const bob = h.addUser({ email: 'bob@example.test' });
    const aliceTokens = await h.signIn(alice.user.id, alice.deviceId);
    const bobTokens = await h.signIn(bob.user.id, bob.deviceId);
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(aliceTokens.access_token),
    });
    const { id } = created.json<{ id: string }>();

    const pending = await h.app.inject({
      method: 'GET',
      url: `/v1/me/export/${id}`,
      headers: bearer(aliceTokens.access_token),
    });
    expect(pending.json()).toMatchObject({ id, status: 'pending', download_url: null });

    const theirs = await h.app.inject({
      method: 'GET',
      url: `/v1/me/export/${id}`,
      headers: bearer(bobTokens.access_token),
    });
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toMatchObject({ code: 'not_found' });
    for (const bad of ['nope', newId('usr')]) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/v1/me/export/${bad}`,
        headers: bearer(aliceTokens.access_token),
      });
      expect(res.statusCode).toBe(404);
    }

    await h.store.markReady(
      id,
      `exports/${alice.user.id}/${id}.json`,
      1234,
      new Date(h.clock.now() + 7 * DAY_MS),
    );
    const ready = await h.app.inject({
      method: 'GET',
      url: `/v1/me/export/${id}`,
      headers: bearer(aliceTokens.access_token),
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.headers['cache-control']).toBe('no-store');
    const view = ready.json<{ status: string; download_url: string; size_bytes: number }>();
    expect(validate('api/DataExport', view).ok).toBe(true);
    expect(view).toMatchObject({ status: 'ready', size_bytes: 1234 });
    const url = new URL(view.download_url);
    const expires = Number(url.searchParams.get('expires')) * 1000;
    expect(Math.abs(expires - (h.clock.now() + 900 * SECOND))).toBeLessThanOrEqual(5 * SECOND);
    expect(h.blobs.presigned.at(-1)).toMatchObject({ ttlS: 900 });
    // The URL is never logged.
    expect(h.captured.raw()).not.toContain(view.download_url);
    expect(h.captured.raw()).not.toContain('X-Amz');

    // Close to the file's expiry the URL lasts only until then; past it the export is expired.
    h.clock.advance(7 * DAY_MS - 60 * SECOND);
    const lateTokens = await h.signIn(alice.user.id, alice.deviceId);
    const late = await h.app.inject({
      method: 'GET',
      url: `/v1/me/export/${id}`,
      headers: bearer(lateTokens.access_token),
    });
    expect(h.blobs.presigned.at(-1)).toMatchObject({ ttlS: 60 });
    expect(late.json()).toMatchObject({ status: 'ready' });
    h.clock.advance(61 * SECOND);
    const expired = await h.app.inject({
      method: 'GET',
      url: `/v1/me/export/${id}`,
      headers: bearer(lateTokens.access_token),
    });
    expect(expired.json()).toMatchObject({ status: 'expired', download_url: null });
    await h.app.close();
  });

  it('shows a failed export as failed, without a URL', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const tokens = await h.signIn(user.id, deviceId);
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(tokens.access_token),
    });
    const { id } = created.json<{ id: string }>();
    await h.store.markFailed(id, 'storage_unavailable');
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/me/export/${id}`,
      headers: bearer(tokens.access_token),
    });
    expect(res.json()).toMatchObject({ status: 'failed', download_url: null });
    // A failed export does not count against the 24-hour window.
    const again = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(tokens.access_token),
    });
    expect(again.statusCode).toBe(202);
    await h.app.close();
  });

  it('still allows an export while a deletion is pending (data portability)', async () => {
    const h = await lifecycleApp();
    const { user, deviceId } = h.addUser();
    const before = await h.signIn(user.id, deviceId);
    await h.app.inject({ method: 'DELETE', url: '/v1/me', headers: bearer(before.access_token) });
    h.clock.advance(2 * SECOND);
    const tokens = await h.signIn(user.id, h.addDevice(user.id));
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/me/export',
      headers: bearer(tokens.access_token),
    });
    expect(res.statusCode).toBe(202);
    await h.app.close();
  });
});
