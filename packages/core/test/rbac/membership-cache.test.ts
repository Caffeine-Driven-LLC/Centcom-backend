/**
 * The membership cache (B021 acceptance 5, card test membership-cache.test.ts): answers are reused
 * for at most 2 s, dropped at once by an `rbac:invalidate` message (through B009's pub/sub), never
 * cached when the read fails, and bounded in number.
 */
import { describe, expect, it } from 'vitest';
import {
  cachedMembershipReader,
  createAuthorizer,
  createMemoryRedis,
  MEMBERSHIP_CACHE_TTL_MS,
  publishInvalidation,
  RBAC_INVALIDATE_CHANNEL,
  subscribeInvalidations,
} from '../../src/index.js';
import { ACTOR_ID, memoryMemberships, OTHER_ID, SESSION, user, WORKSPACE } from './helpers.js';

const T0 = Date.parse('2026-10-07T12:00:00.000Z');

function clock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => void (current += ms) };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('cachedMembershipReader', () => {
  it('reuses an answer for 2 s and reads again after (acceptance 5, without invalidation)', async () => {
    const inner = memoryMemberships();
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'member');
    const time = clock();
    const cached = cachedMembershipReader(inner, { now: time.now });
    expect(await cached.workspaceRole(ACTOR_ID, WORKSPACE)).toBe('member');
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'admin');
    time.advance(MEMBERSHIP_CACHE_TTL_MS - 1);
    expect(await cached.workspaceRole(ACTOR_ID, WORKSPACE)).toBe('member');
    time.advance(1);
    expect(await cached.workspaceRole(ACTOR_ID, WORKSPACE)).toBe('admin');
    expect(inner.reads).toBe(2);
    expect(MEMBERSHIP_CACHE_TTL_MS).toBe(2_000);
  });

  it('sees a role change at once after an rbac:invalidate message (acceptance 5)', async () => {
    const inner = memoryMemberships();
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'member');
    inner.session.set(`${ACTOR_ID}|${SESSION}`, 'viewer');
    const redis = createMemoryRedis();
    const cached = cachedMembershipReader(inner, { now: clock().now });
    const unsubscribe = await subscribeInvalidations(redis.pubsub, cached);
    expect(await cached.workspaceRole(ACTOR_ID, WORKSPACE)).toBe('member');
    expect(await cached.sessionRole(ACTOR_ID, SESSION)).toBe('viewer');
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'admin');
    inner.session.set(`${ACTOR_ID}|${SESSION}`, 'editor');
    await publishInvalidation(redis.pubsub, { userId: ACTOR_ID, workspaceId: WORKSPACE });
    await flush();
    expect(await cached.workspaceRole(ACTOR_ID, WORKSPACE)).toBe('admin');
    // Only matching answers went: the session role is still the cached one.
    expect(await cached.sessionRole(ACTOR_ID, SESSION)).toBe('viewer');
    await redis.pubsub.publish(RBAC_INVALIDATE_CHANNEL, 'not json');
    await flush();
    expect(await cached.sessionRole(ACTOR_ID, SESSION)).toBe('editor');
    await unsubscribe();
  });

  it('drops by user, workspace or session, or everything', async () => {
    const inner = memoryMemberships();
    const cached = cachedMembershipReader(inner, { now: clock().now });
    await cached.workspaceRole(ACTOR_ID, WORKSPACE);
    await cached.workspaceRole(OTHER_ID, WORKSPACE);
    await cached.sessionRole(ACTOR_ID, SESSION);
    expect(cached.size()).toBe(3);
    cached.invalidate({ userId: OTHER_ID });
    expect(cached.size()).toBe(2);
    cached.invalidate({ sessionId: SESSION });
    expect(cached.size()).toBe(1);
    cached.invalidate();
    expect(cached.size()).toBe(0);
  });

  it('does not cache a failed read, refuses a TTL over 2 s, and keeps a bounded number of answers', async () => {
    const inner = memoryMemberships();
    const cached = cachedMembershipReader(inner, { now: clock().now, maxEntries: 2 });
    inner.fail = true;
    await expect(cached.workspaceRole(ACTOR_ID, WORKSPACE)).rejects.toThrow('connection refused');
    inner.fail = false;
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'owner');
    expect(await cached.workspaceRole(ACTOR_ID, WORKSPACE)).toBe('owner');
    await cached.workspaceRole(OTHER_ID, WORKSPACE);
    await cached.sessionRole(ACTOR_ID, SESSION);
    expect(cached.size()).toBe(2);
    expect(() => cachedMembershipReader(inner, { ttlMs: 2_001 })).toThrow(RangeError);
    expect(() => cachedMembershipReader(inner, { ttlMs: -1 })).toThrow(RangeError);
  });

  it('turns a role the reader does not know into no role', async () => {
    const cached = cachedMembershipReader(
      {
        workspaceRole: () => Promise.resolve('superadmin' as never),
        sessionRole: () => Promise.resolve('audience' as never),
      },
      { now: clock().now },
    );
    expect(await cached.workspaceRole(ACTOR_ID, WORKSPACE)).toBeNull();
    expect(await cached.sessionRole(ACTOR_ID, SESSION)).toBeNull();
  });

  it('serves authorize: a promotion is effective within 2 s, or at once after invalidation (acceptance 5)', async () => {
    const inner = memoryMemberships();
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'member');
    const time = clock();
    const redis = createMemoryRedis();
    const cached = cachedMembershipReader(inner, { now: time.now });
    await subscribeInvalidations(redis.pubsub, cached);
    const authorizer = createAuthorizer({
      memberships: cached,
      audit: { record: () => Promise.resolve() },
      now: time.now,
    });
    await expect(
      authorizer.authorize(user(), 'workspace.update', { workspaceId: WORKSPACE }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'admin');
    time.advance(MEMBERSHIP_CACHE_TTL_MS);
    await expect(
      authorizer.authorize(user(), 'workspace.update', { workspaceId: WORKSPACE }),
    ).resolves.toBeUndefined();
    inner.workspace.set(`${ACTOR_ID}|${WORKSPACE}`, 'member');
    await publishInvalidation(redis.pubsub, { workspaceId: WORKSPACE });
    await flush();
    await expect(
      authorizer.authorize(user(), 'workspace.update', { workspaceId: WORKSPACE }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
