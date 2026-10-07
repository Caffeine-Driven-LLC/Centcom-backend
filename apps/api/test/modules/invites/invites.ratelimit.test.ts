/**
 * The public preview's rate limit (B029 acceptance 3, B023, CT-PAGE): anonymous callers count in
 * the anonymous bucket, 30 a minute per address, unknown tokens included (guessing tokens is no
 * faster); the 31st call in a minute is a 429 with `Retry-After`. Another address has its own
 * count.
 */
import { randomBytes } from 'node:crypto';
import { defaultBuckets } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { arrange, createInvite, invitesApp } from './helpers.js';

describe('the preview', () => {
  it('allows 30 anonymous calls a minute per address; the 31st is a 429 with Retry-After', async () => {
    expect(defaultBuckets.anonymous).toEqual({ limit: 30, windowS: 60 });
    const t = await invitesApp({ rateLimit: true });
    const { workspaceId, users } = arrange(t.store);
    const created = await createInvite(t, workspaceId, users.admin);
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      // Half of them guess: unknown tokens count as much as real ones.
      const token = i % 2 === 0 ? created.token : randomBytes(20).toString('base64url');
      const res = await t.app.inject({ url: `/v1/invites/${token}` });
      expect(res.headers['ratelimit-limit']).toBe('30');
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(15);
    expect(statuses.filter((s) => s === 404)).toHaveLength(15);
    const refused = await t.app.inject({ url: `/v1/invites/${created.token}` });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    const retryAfter = Number(refused.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.headers['ratelimit-remaining']).toBe('0');
    // Another address is counted apart.
    const elsewhere = await t.app.inject({
      url: `/v1/invites/${created.token}`,
      remoteAddress: '203.0.113.7',
    });
    expect(elsewhere.statusCode).toBe(200);
  });
});
