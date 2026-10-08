/**
 * Feature flags on Postgres 16 (B083; DATABASE_URL, CI's integration job): the repository, B036's
 * emitter and the cache over the migrated schema.
 *
 * - a change and its `flag.set` / `flag.delete` audit row are written together, and the revision
 *   moves by exactly 1; an audit failure leaves neither;
 * - the count and response-size limits hold, also for concurrent changes, which get distinct,
 *   consecutive revisions;
 * - values come back with their JSON types, and the cache reloads when the revision moves.
 */
import { createAuditEmitter, createMemoryRedis } from '@centcom/core';
import type { AuditDatabase, FlagDatabase } from '@centcom/db';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import { FLAG_AUDIT_ACTIONS } from '../../src/modules/flags/actions.js';
import { FlagCache } from '../../src/modules/flags/cache.js';
import {
  createFlagRepository,
  FlagLimitError,
  type FlagAudit,
} from '../../src/modules/flags/repository.js';
import { FlagAdmin } from '../../src/modules/flags/service.js';
import { ADMIN_URL, migratedDatabase } from '../modules/users/helpers.js';
import { boolFlag, staff, T0 } from './helpers.js';

const LIMITS = { maxCount: 500, maxBodyBytes: 64 * 1024 - 64 };
const noAudit: FlagAudit = () => Promise.resolve();
const full = (def: ReturnType<typeof boolFlag>) => ({
  public: false,
  server_only: false,
  kill: false,
  rules: [],
  ...def,
});

describe.runIf(ADMIN_URL !== undefined)('feature flags on Postgres 16', () => {
  it('changes flags, their revision and their audit rows together', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<FlagDatabase>;
      const repo = createFlagRepository(db);
      expect(await repo.load()).toEqual({ rev: 0, rows: [] });
      expect(await repo.rev()).toBe(0);
      const admin = new FlagAdmin({
        repository: repo,
        emitter: createAuditEmitter({ db, actions: FLAG_AUDIT_ACTIONS, clock: () => T0 }),
        pubsub: createMemoryRedis().pubsub,
        config: { maxCount: 500, maxValueBytes: 2048 },
        clock: () => T0,
      });
      await admin.setFlag(boolFlag('banner', { public: true }), staff);
      await admin.setFlag(
        {
          key: 'limits',
          type: 'json',
          value: { queue: 50, mode: 'fast' },
          default: { queue: 10 },
          rules: [{ type: 'percent', percent: 12.5 }],
        },
        staff,
      );
      await admin.setFlag(boolFlag('banner', { public: true, kill: true }), staff);
      expect(await repo.rev()).toBe(3);
      const loaded = await repo.load();
      expect(loaded.rev).toBe(3);
      expect(
        loaded.rows.map((r) => [r.key, r.value, r.default_value, r.kill, r.rules]).sort(),
      ).toEqual([
        ['banner', true, false, true, []],
        [
          'limits',
          { mode: 'fast', queue: 50 },
          { queue: 10 },
          false,
          [{ type: 'percent', percent: 12.5 }],
        ],
      ]);
      expect(await admin.deleteFlag('banner', staff)).toEqual({ rev: 4 });
      await expect(admin.deleteFlag('banner', staff)).rejects.toMatchObject({ status: 404 });
      expect(await repo.rev()).toBe(4);

      const audit = await (t.db as unknown as Kysely<AuditDatabase>)
        .selectFrom('audit_events')
        .select(['action', 'actor_id', 'meta', 'workspace_id'])
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      expect(audit.map((r) => r.action)).toEqual([
        'flag.set',
        'flag.set',
        'flag.set',
        'flag.delete',
      ]);
      expect(audit[2]).toMatchObject({
        actor_id: staff.userId,
        workspace_id: null,
        meta: {
          flag: 'banner',
          rev: 3,
          created: false,
          kill: true,
          prev_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        },
      });

      // An audit failure undoes the change.
      await expect(
        repo.upsert(full(boolFlag('ghost')), staff.userId, new Date(T0), LIMITS, () =>
          Promise.reject(new Error('audit insert failed')),
        ),
      ).rejects.toThrow('audit insert failed');
      expect(await repo.rev()).toBe(4);
      expect((await repo.load()).rows.map((r) => r.key)).toEqual(['limits']);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('holds the count and size limits, also under concurrent changes', async () => {
    const t = await migratedDatabase(10);
    try {
      const db = t.db as unknown as Kysely<FlagDatabase>;
      const repo = createFlagRepository(db);
      const limits = { maxCount: 12, maxBodyBytes: 64 * 1024 - 64 };
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          repo.upsert(
            full(boolFlag(`f${String(i).padStart(2, '0')}`)),
            staff.userId,
            new Date(T0),
            limits,
            noAudit,
          ),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(12);
      expect(
        refused.every((r) => (r as PromiseRejectedResult).reason instanceof FlagLimitError),
      ).toBe(true);
      const revs = ok
        .map((r) => (r as PromiseFulfilledResult<{ rev: number }>).value.rev)
        .sort((a, b) => a - b);
      expect(revs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect((await repo.load()).rows).toHaveLength(12);

      // The response budget: client-visible flags only.
      const big = (key: string, server_only = false) =>
        repo.upsert(
          {
            ...full(boolFlag(key)),
            type: 'string',
            value: 'v'.repeat(2000),
            default: '',
            server_only,
          },
          staff.userId,
          new Date(T0),
          { maxCount: 500, maxBodyBytes: 5000 },
          noAudit,
        );
      await big('copy.a');
      await big('copy.b');
      await expect(big('copy.c')).rejects.toMatchObject({ limit: 'body' });
      await big('copy.c', true);
    } finally {
      await t.drop();
    }
  }, 60_000);

  it('feeds the cache, which reloads when the revision moves', async () => {
    const t = await migratedDatabase(5);
    try {
      const db = t.db as unknown as Kysely<FlagDatabase>;
      const repo = createFlagRepository(db);
      const cache = new FlagCache({ repository: repo });
      await cache.reload();
      expect(cache.current()?.rev).toBe(0);
      await repo.upsert(
        full(boolFlag('a', { public: true })),
        staff.userId,
        new Date(T0),
        LIMITS,
        noAudit,
      );
      await cache.poll();
      expect(cache.current()?.rev).toBe(1);
      expect(cache.current()?.byKey.get('a')).toMatchObject({
        value: true,
        default: false,
        public: true,
      });
      await cache.stop();
    } finally {
      await t.drop();
    }
  }, 60_000);
});
