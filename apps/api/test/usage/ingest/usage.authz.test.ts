/**
 * Who may report usage (B074 acceptance 5): a device token with `usage:write`; another user's
 * session (the caller takes no part) is 403 for the whole batch and stores nothing, as is a
 * session that does not exist; an API key is 403 (usage is device-reported), even holding
 * `usage:write`; a token without a device is 403; a token without `usage:write` is 403; no token
 * is 401.
 */
import { describe, expect, it } from 'vitest';
import { newId, usageApp, usageEvent } from './helpers.js';

describe('POST /v1/usage/events authorisation', () => {
  it('refuses a session the caller does not take part in with 403, storing nothing', async () => {
    const ctx = await usageApp();
    const d = await ctx.device();
    ctx.memory.personal(d.userId);
    const theirs = newId('ses');
    ctx.memory.sessions.set(theirs, {
      workspaceId: newId('wsp'),
      createdBy: newId('usr'),
      members: [newId('usr')],
    });
    for (const session of [theirs, newId('ses')]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/usage/events',
        headers: d.headers(),
        payload: { events: [usageEvent(), usageEvent({ session_id: session })] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('forbidden');
    }
    expect(ctx.memory.rows.size).toBe(0);
    await ctx.app.close();
  });

  it('refuses an API key even with usage:write, and a token without usage:write', async () => {
    const ctx = await usageApp();
    const key = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: {
        authorization: `Bearer cen_live_${'k'.repeat(32)}`,
        'idempotency-key': crypto.randomUUID(),
      },
      payload: { events: [usageEvent()] },
    });
    expect(key.statusCode).toBe(403);
    const d = await ctx.device({ scopes: ['profile'] });
    ctx.memory.personal(d.userId);
    const scoped = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: d.headers(),
      payload: { events: [usageEvent()] },
    });
    expect(scoped.statusCode).toBe(403);
    const none = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: { 'idempotency-key': crypto.randomUUID() },
      payload: { events: [usageEvent()] },
    });
    expect(none.statusCode).toBe(401);
    expect(ctx.memory.rows.size).toBe(0);
    await ctx.app.close();
  });

  it('refuses a token without a device', async () => {
    const ctx = await usageApp();
    const user = newId('usr');
    ctx.memory.personal(user);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/usage/events',
      headers: await ctx.deviceless(user),
      payload: { events: [usageEvent()] },
    });
    expect(response.statusCode).toBe(403);
    expect(ctx.memory.rows.size).toBe(0);
    await ctx.app.close();
  });
});
