/**
 * B089 on Postgres 16 with the card's seed (10 000 workspaces, 50 000 users, 100 000 sessions):
 *
 * - Acceptance 1: a trigram query's first page in <= 100 ms at p95 (20 warm runs), and the plan
 *   uses the trigram index (EXPLAIN).
 * - Acceptance 2: a full session id returns that session first.
 * - Acceptance 6: pages give each hit exactly once while rows are inserted; a cursor with another
 *   `q` is 400 `cursor_invalid`.
 * - Acceptance 7: `'; drop table users; --` and `%` / `_` return normal (empty) results.
 * - Ranking: closer names first, then the newest; ended sessions flagged.
 */
import { isAppError } from '@centcom/core';
import type { CoreDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseQuery } from '../../src/modules/search/query.js';
import {
  assertSearchReady,
  buildSearchQuery,
  searchMetadata,
} from '../../src/modules/search/service.js';
import {
  body,
  deps,
  seedLarge,
  STACK,
  STACK_TIMEOUT_MS,
  startTestStack,
  type TestStack,
} from './helpers.js';

describe.runIf(STACK)('metadata search on Postgres 16 (seeded)', () => {
  let stack: TestStack;
  let db: Kysely<CoreDatabase>;
  beforeAll(async () => {
    stack = await startTestStack();
    db = stack.db as unknown as Kysely<CoreDatabase>;
    await seedLarge(db);
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('pg_trgm is there (the service may start)', async () => {
    await expect(assertSearchReady(db)).resolves.toBeUndefined();
  });

  it('the first page of a trigram query in <= 100 ms at p95, using the trigram index', async () => {
    const q = 'sprint 4242';
    const plan = await sql<{ 'QUERY PLAN': string }>`explain ${buildSearchQuery(
      normaliseQuery(q),
      ['session'],
      { scope: { kind: 'staff' } },
      null,
      20,
    )}`.execute(db);
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('idx_sessions_name_trgm');
    const times: number[] = [];
    for (let i = 0; i < 22; i++) {
      const start = performance.now();
      const page = await searchMetadata(deps(db), { q, scope: { kind: 'staff' }, limit: 20 });
      times.push(performance.now() - start);
      expect(page.data.length).toBeGreaterThan(0);
    }
    const warm = times.slice(2).sort((x, y) => x - y);
    expect(warm[Math.ceil(warm.length * 0.95) - 1]).toBeLessThanOrEqual(100);
  }, 60_000);

  it('a full session id returns that session first', async () => {
    const id = `ses_${body(4243)}`;
    const page = await searchMetadata(deps(db), { q: id, scope: { kind: 'staff' } });
    expect(page.data[0]).toMatchObject({
      type: 'session',
      id,
      label: 'delta sprint 4243',
      score: 2,
    });
  });

  it('ranks closer names first, then the newest; flags ended sessions', async () => {
    const page = await searchMetadata(deps(db), {
      q: 'sprint 4242',
      types: ['session'],
      scope: { kind: 'staff' },
      limit: 5,
    });
    // Every hit contains the query; best similarity first (shorter names score higher).
    expect(page.data.every((h) => h.label.includes('sprint 4242'))).toBe(true);
    const scores = page.data.map((h) => h.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    // The same name exactly ranks first.
    const exact = await searchMetadata(deps(db), {
      q: 'delta sprint 4243',
      types: ['session'],
      scope: { kind: 'staff' },
      limit: 3,
    });
    expect(exact.data[0]?.label).toBe('delta sprint 4243');
    const ended = await searchMetadata(deps(db), {
      q: 'sprint 7',
      types: ['session'],
      scope: { kind: 'staff' },
      limit: 50,
    });
    expect(ended.data.some((h) => h.label.endsWith(' (ended)'))).toBe(true);
  });

  it('pages give each hit exactly once while rows are inserted; another q is 400', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof searchMetadata>> = await searchMetadata(deps(db), {
        q: 'sprint 999',
        types: ['session'],
        scope: { kind: 'staff' },
        limit: 7,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.data.map((h) => h.id));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
      // A new matching session lands between pages.
      await sql`
        insert into sessions (id, workspace_id, name, state, region, created_by)
        values (${`ses_${body(900_000 + pages)}`}, ${`wsp_${body(1)}`}, ${`alpha sprint 999${pages}`},
                'live', 'eu', ${`usr_${body(1)}`})`.execute(db);
    } while (cursor !== undefined && pages < 50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(`ses_${body(999)}`);
    const first = await searchMetadata(deps(db), {
      q: 'sprint 999',
      scope: { kind: 'staff' },
      limit: 2,
    });
    const other = searchMetadata(deps(db), {
      q: 'sprint 998',
      scope: { kind: 'staff' },
      cursor: first.next_cursor ?? '',
    });
    await expect(other).rejects.toSatisfy(
      (err: unknown) => isAppError(err) && err.code === 'cursor_invalid',
    );
  }, 60_000);

  it('rows tied on score and created_at (one statement) page out exactly once, newest first', async () => {
    // Twelve sessions with one name, written in one statement: one now(), with microseconds.
    await sql`
      insert into sessions (id, workspace_id, name, state, region, created_by)
      select 'ses_' || lpad((800000 + i)::text, 26, '0'), ${`wsp_${body(2)}`}, 'zulu tie',
             'live', 'eu', ${`usr_${body(1)}`}
      from generate_series(1, 12) i`.execute(db);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page: Awaited<ReturnType<typeof searchMetadata>> = await searchMetadata(deps(db), {
        q: 'zulu tie',
        types: ['session'],
        scope: { kind: 'staff' },
        limit: 5,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.data.map((h) => h.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    // Equal scores: the newest first (here equal times, then the id).
    const older = `ses_${body(800_100)}`;
    await sql`
      insert into sessions (id, workspace_id, name, state, region, created_by, created_at)
      values (${older}, ${`wsp_${body(2)}`}, 'zulu tie', 'live', 'eu', ${`usr_${body(1)}`},
              now() - interval '1 day')`.execute(db);
    const all = await searchMetadata(deps(db), {
      q: 'zulu tie',
      types: ['session'],
      scope: { kind: 'staff' },
      limit: 50,
    });
    expect(all.data.at(-1)?.id).toBe(older);
    const times = all.data.map((h) => Date.parse(h.created_at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it('injection text and LIKE wildcards return normal (empty) results', async () => {
    for (const q of ["'; drop table users; --", '%%', '__', '%_%']) {
      const page = await searchMetadata(deps(db), { q, scope: { kind: 'staff' } });
      expect(page.data).toEqual([]);
    }
    const users = await sql<{ n: number }>`select count(*)::int as n from users`.execute(db);
    expect(users.rows[0]?.n).toBeGreaterThanOrEqual(50_000);
  });
});
