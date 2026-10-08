/**
 * The flags admin API (B083: `setFlag`, `deleteFlag`, `listFlags` for B087's tooling):
 *
 * - every change adds exactly 1 to the revision and writes `flag.set` / `flag.delete` with the
 *   actor, the flag's key, the new revision and a hash of the previous definition (never a value);
 * - a value over 2 048 bytes, the 501st flag, or a definition that would take the answer past
 *   64 KiB is refused with a 422, and nothing changes;
 * - keys naming secrets are refused; a lost announcement still leaves every process to catch up
 *   by polling.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, isAppError } from '@centcom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FLAGS_BODY_BYTES } from '../../src/modules/flags/service.js';
import { boolFlag, flagsWorld, getFlags, staff, T0, type FlagsWorld } from './helpers.js';

let world: FlagsWorld;
afterEach(async () => {
  await world.close();
});

/** The 422 `fn` rejects with: its pointers. */
async function refused(fn: () => Promise<unknown>): Promise<string[]> {
  try {
    await fn();
  } catch (err) {
    if (isAppError(err) && err.status === 422) return (err.errors ?? []).map((e) => e.pointer);
    throw err;
  }
  throw new Error('expected a 422');
}

describe('changes', () => {
  it('moves the revision by exactly 1 per change and audits each with the previous hash', async () => {
    world = flagsWorld();
    const { admin } = await world.instance();
    expect(await admin.setFlag(boolFlag('banner', { public: true }), staff)).toEqual({ rev: 1 });
    expect(await admin.setFlag(boolFlag('banner', { public: true, kill: true }), staff)).toEqual({
      rev: 2,
    });
    expect(await admin.deleteFlag('banner', staff)).toEqual({ rev: 3 });
    expect(world.repo.revision).toBe(3);

    const hashOf = (def: Record<string, unknown>) =>
      createHash('sha256').update(canonicalJson(def), 'utf8').digest('hex');
    const first = {
      key: 'banner',
      type: 'bool',
      value: true,
      default: false,
      public: true,
      server_only: false,
      kill: false,
      rules: [],
    };
    const audited = world.repo.audited.map((row) => ({
      ...row,
      meta: JSON.parse(String(row['meta'])) as unknown,
    }));
    expect(audited).toEqual([
      expect.objectContaining({
        workspace_id: null,
        actor_type: 'user',
        actor_id: staff.userId,
        action: 'flag.set',
        outcome: 'success',
        meta: { flag: 'banner', rev: 1, prev_hash: null, created: true, kill: false },
      }),
      expect.objectContaining({
        action: 'flag.set',
        meta: { flag: 'banner', rev: 2, prev_hash: hashOf(first), created: false, kill: true },
      }),
      expect.objectContaining({
        action: 'flag.delete',
        meta: { flag: 'banner', rev: 3, prev_hash: hashOf({ ...first, kill: true }) },
      }),
    ]);
    // No value or rule reaches the audit log.
    expect(JSON.stringify(world.repo.audited)).not.toMatch(/"value"|"default"|rules/);

    // API keys are audited as themselves.
    const key = {
      kind: 'api_key' as const,
      keyId: 'key_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      workspaceId: 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      scopes: [],
    };
    await admin.setFlag(boolFlag('other'), key);
    expect(world.repo.audited.at(-1)).toMatchObject({ actor_type: 'api_key', actor_id: key.keyId });
  });

  it('lists every flag, complete, by key', async () => {
    world = flagsWorld();
    const { admin } = await world.instance();
    world.clock.now = T0 + 1000;
    await admin.setFlag(boolFlag('zeta', { rules: [{ type: 'percent', percent: 10 }] }), staff);
    await admin.setFlag(
      { key: 'alpha', type: 'number', value: 3, default: 1, server_only: true },
      staff,
    );
    expect(await admin.listFlags()).toEqual([
      {
        key: 'alpha',
        type: 'number',
        value: 3,
        default: 1,
        public: false,
        server_only: true,
        kill: false,
        rules: [],
        updated_by: staff.userId,
        updated_at: new Date(T0 + 1000).toISOString(),
      },
      expect.objectContaining({ key: 'zeta', rules: [{ type: 'percent', percent: 10 }] }),
    ]);
  });

  it('answers 404 for deleting a flag that does not exist, and leaves the revision', async () => {
    world = flagsWorld();
    const { admin } = await world.instance();
    for (const key of ['missing', 'Not Valid']) {
      await expect(admin.deleteFlag(key, staff)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
    }
    expect(world.repo.revision).toBe(0);
    expect(world.repo.audited).toEqual([]);
  });
});

describe('limits', () => {
  it('refuses a value over 2 048 bytes and the 501st flag with a validation error', async () => {
    world = flagsWorld();
    const { admin } = await world.instance();
    const big = { key: 'copy', type: 'string', value: 'x'.repeat(2047), default: '' };
    expect(await refused(() => admin.setFlag(big, staff))).toEqual(['/value']);
    expect(await admin.setFlag({ ...big, value: 'x'.repeat(2046) }, staff)).toEqual({ rev: 1 });

    for (let i = 1; i < 500; i += 1) {
      await admin.setFlag(boolFlag(`f${String(i).padStart(3, '0')}`, { server_only: true }), staff);
    }
    expect(world.repo.rows.size).toBe(500);
    expect(
      await refused(() => admin.setFlag(boolFlag('f501', { server_only: true }), staff)),
    ).toEqual(['/key']);
    expect(world.repo.rows.size).toBe(500);
    expect(world.repo.revision).toBe(500);
    // Replacing an existing flag is still allowed at the limit.
    expect(await admin.setFlag(boolFlag('f001', { server_only: true, kill: true }), staff)).toEqual(
      { rev: 501 },
    );
  });

  it('refuses a definition that would take the answer past 64 KiB', async () => {
    world = flagsWorld();
    const { admin, app } = await world.instance();
    const value = 'v'.repeat(2000);
    let i = 0;
    for (;;) {
      const key = `copy.${String(i).padStart(3, '0')}`;
      try {
        await admin.setFlag({ key, type: 'string', value, default: '', public: true }, staff);
      } catch (err) {
        expect(isAppError(err) && err.status === 422).toBe(true);
        break;
      }
      i += 1;
    }
    expect(i).toBeGreaterThan(25);
    const res = await getFlags(app);
    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(MAX_FLAGS_BODY_BYTES);
    // server_only flags never reach the answer, so they do not count.
    expect(
      await admin.setFlag(
        { key: 'ops.copy', type: 'string', value, default: '', server_only: true },
        staff,
      ),
    ).toEqual({
      rev: i + 1,
    });
  });

  it('refuses keys that name secrets, and secret-like values', async () => {
    world = flagsWorld();
    const { admin } = await world.instance();
    expect(await refused(() => admin.setFlag(boolFlag('stripe.secret'), staff))).toEqual(['/key']);
    expect(
      await refused(() =>
        admin.setFlag(
          { key: 'support', type: 'string', value: 'help@example.test', default: '' },
          staff,
        ),
      ),
    ).toEqual(['/value']);
    expect(world.repo.revision).toBe(0);
  });
});

describe('announcements', () => {
  it('keeps a change when its announcement fails; polling catches it up', async () => {
    world = flagsWorld();
    const { admin, cache, recorded } = await world.instance();
    const publish = world.redis.pubsub.publish.bind(world.redis.pubsub);
    world.redis.pubsub.publish = () => Promise.reject(new Error('redis down'));
    expect(await admin.setFlag(boolFlag('quiet'), staff)).toEqual({ rev: 1 });
    expect(recorded.count('flags_publish_failures_total')).toBe(1);
    world.redis.pubsub.publish = publish;
    expect(cache.current()?.rev).toBe(0);
    await cache.poll();
    expect(cache.current()?.rev).toBe(1);
  });

  it('answers 503 when Postgres is down, and changes nothing', async () => {
    world = flagsWorld();
    const { admin } = await world.instance();
    world.repo.down = true;
    await expect(admin.setFlag(boolFlag('x'), staff)).rejects.toMatchObject({ status: 503 });
    await expect(admin.deleteFlag('x', staff)).rejects.toMatchObject({ status: 503 });
    await expect(admin.listFlags()).rejects.toMatchObject({ status: 503 });
  });
});
