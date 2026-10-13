/**
 * B089 scope, privacy and failures on Postgres 16:
 *
 * - Acceptance 3: in `member` scope, hits come only from the user's workspaces; another
 *   workspace's matching session gives zero hits for that user (scoped in SQL).
 * - Acceptance 4: emails are searched and shown only in `staff` scope.
 * - Acceptance 5: a string stored only in content-bearing places (a test ciphertext blob, an
 *   invite's `key_bundle`, and a branch-like name, a device's name) is never found; every index of
 *   the searched tables is on an allow-listed column (index definitions read from Postgres).
 * - Failure path: a statement over the 2 s timeout is 503 with `retry_after_s`.
 * - The route: `GET /search` behind its access check; `q` is never logged.
 */
import { isAppError } from '@centcom/core';
import type { CoreDatabase } from '@centcom/db';
import Fastify from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchForMember, searchPlugin } from '../../src/modules/search/plugin.js';
import { searchMetadata } from '../../src/modules/search/service.js';
import {
  deps,
  seedSmall,
  STACK,
  STACK_TIMEOUT_MS,
  startTestStack,
  type TestStack,
} from './helpers.js';

describe.runIf(STACK)('search scope and privacy on Postgres 16', () => {
  let stack: TestStack;
  let db: Kysely<CoreDatabase>;
  let world: Awaited<ReturnType<typeof seedSmall>>;
  beforeAll(async () => {
    stack = await startTestStack();
    db = stack.db as unknown as Kysely<CoreDatabase>;
    world = await seedSmall(db);
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it("member scope: only the user's workspaces", async () => {
    const page = await searchForMember(deps(db), world.alice, { q: 'quarterly planning' });
    expect(page.data.map((h) => h.id)).toEqual([world.oursSession]);
    const theirs = await searchForMember(deps(db), world.alice, { q: 'planning theirs' });
    expect(theirs.data).toEqual([]);
    const ws = await searchForMember(deps(db), world.alice, { q: 'studio', types: ['workspace'] });
    expect(ws.data.map((h) => h.id)).toEqual([world.ours]);
    // Users: only those sharing a workspace with Alice.
    const bob = await searchForMember(deps(db), world.alice, { q: 'bob other', types: ['user'] });
    expect(bob.data).toEqual([]);
    const staff = await searchMetadata(deps(db), {
      q: 'quarterly planning',
      scope: { kind: 'staff' },
    });
    expect(staff.data.map((h) => h.id).sort()).toEqual(
      [world.oursSession, world.theirsSession].sort(),
    );
  });

  it('emails only in staff scope', async () => {
    const email = (
      await db
        .selectFrom('users')
        .select('email')
        .where('id', '=', world.alice)
        .executeTakeFirstOrThrow()
    ).email;
    const prefix = email.slice(0, 8);
    const staff = await searchMetadata(deps(db), {
      q: prefix,
      types: ['user'],
      scope: { kind: 'staff' },
    });
    expect(staff.data.map((h) => h.id)).toEqual([world.alice]);
    expect(staff.data[0]?.label).toContain(email);
    const member = await searchForMember(deps(db), world.alice, { q: prefix, types: ['user'] });
    expect(member.data).toEqual([]);
    const byName = await searchForMember(deps(db), world.alice, { q: 'alice', types: ['user'] });
    expect(byName.data.map((h) => h.label)).toEqual(['Alice Example']);
  });

  it('never finds content; every index of the searched tables is allow-listed', async () => {
    const needle = 'zebra-needle-only-in-content';
    // A test ciphertext blob holding the needle in clear bytes (an invite's sealed key bundle).
    await sql`
      insert into invites (id, workspace_id, role, token_hash, created_by, expires_at, key_bundle,
                           key_bundle_expires_at)
      values ('inv_01JA3Z8K2M5N7P9Q0R1S2T3V4W', ${world.ours}, 'member', ${Buffer.alloc(32, 7)},
              ${world.alice}, now() + interval '1 day',
              ${Buffer.from(needle.padEnd(64, '#'), 'utf8')}, now() + interval '1 day')`.execute(
      db,
    );
    await sql`
      insert into devices (id, user_id, name, platform, x25519_pub, ed25519_pub, fingerprint)
      values ('dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W', ${world.alice}, ${`feature/${needle}`}, 'linux',
              ${'A'.repeat(43)}, ${'B'.repeat(43)}, 'ABCD-EFGH-IJKL')`.execute(db);
    const page = await searchMetadata(deps(db), { q: needle, scope: { kind: 'staff' } });
    expect(page.data).toEqual([]);
    const indexes = await sql<{ tablename: string; indexdef: string }>`
      select tablename, indexdef from pg_indexes
      where tablename in ('sessions', 'workspaces', 'users', 'memberships')
        and indexdef ~* 'gin|trgm|text_pattern_ops'`.execute(db);
    const allowed = [
      /idx_sessions_name_trgm .*lower\(name\)/,
      /idx_workspaces_name_trgm .*lower\(name\)/,
      /idx_workspaces_slug_trgm .*\(slug gin_trgm_ops\)/,
      /idx_users_display_trgm .*lower\(display_name\)/,
      /idx_users_email_lower .*lower\(\(email\)::text\)/,
    ];
    expect(indexes.rows.length).toBe(allowed.length);
    for (const row of indexes.rows) {
      expect(
        allowed.some((re) => re.test(row.indexdef)),
        row.indexdef,
      ).toBe(true);
    }
  });

  it('reads only allow-listed columns to match (the compiled SQL of every type and scope)', async () => {
    const { buildSearchQuery } = await import('../../src/modules/search/service.js');
    const { normaliseQuery, SEARCHABLE_COLUMNS, SEARCH_TYPES } =
      await import('../../src/modules/search/query.js');
    const alias: Record<string, string> = {
      s: 'sessions',
      w: 'workspaces',
      ww: 'workspaces',
      u: 'users',
      m: 'memberships',
      mm: 'memberships',
    };
    // Columns read to scope, flag, order and label, never to match content.
    const meta = new Set([
      'sessions.workspace_id',
      'sessions.state',
      'sessions.created_at',
      'workspaces.deleted_at',
      'workspaces.created_at',
      'users.status',
      'users.created_at',
      'memberships.workspace_id',
      'memberships.user_id',
      'memberships.created_at',
    ]);
    const allowed = new Set([...Object.values(SEARCHABLE_COLUMNS).flat(), ...meta]);
    const q = normaliseQuery('quarterly');
    for (const scope of [
      { kind: 'staff' as const },
      { kind: 'member' as const, userId: world.alice },
    ]) {
      for (const type of SEARCH_TYPES) {
        const compiled = buildSearchQuery(q, [type], { scope }, null, 20).compile(db).sql;
        for (const [, a, col] of compiled.matchAll(/\b(s|w|ww|u|m|mm)\.([a-z_]+)/g)) {
          const ref = `${alias[a ?? ''] ?? '?'}.${col ?? ''}`;
          expect(allowed.has(ref), `${type}/${scope.kind}: ${ref}`).toBe(true);
        }
        if (scope.kind === 'member') expect(compiled).not.toContain('email');
      }
    }
  });

  it('a statement over the timeout is 503 with retry_after_s', async () => {
    const slow = deps(db);
    // Lock the sessions table so the search waits past its 2 s statement timeout.
    const blocker = await db.connection().execute(async (conn) => {
      await sql`begin`.execute(conn);
      await sql`lock table sessions in access exclusive mode`.execute(conn);
      const attempt = searchMetadata(slow, { q: 'quarterly', scope: { kind: 'staff' } }).then(
        () => null,
        (err: unknown) => err,
      );
      const err = await attempt;
      await sql`rollback`.execute(conn);
      return err;
    });
    expect(isAppError(blocker) && blocker.code === 'service_unavailable').toBe(true);
    expect((blocker as { retryAfterS?: number }).retryAfterS).toBe(2);
  }, 30_000);

  it('GET /search declares its query parameters (requireStaff refuses any other)', async () => {
    const app = Fastify();
    await app.register(searchPlugin, {
      // The query check of B087's requireStaff (staff.ts checkImpersonation).
      requireAccess: async (request) => {
        const allowed = (request.routeOptions.config as { adminQuery?: string[] }).adminQuery ?? [];
        for (const name of Object.keys((request.query ?? {}) as object)) {
          if (!allowed.includes(name)) throw new Error(`refused ${name}`);
        }
      },
      search: deps(db),
    });
    const ok = await app.inject({
      method: 'GET',
      url: `/search?q=quarterly&type=session&workspace=${world.ours}&limit=5`,
    });
    expect(ok.statusCode).toBe(200);
    const other = await app.inject({ method: 'GET', url: '/search?q=quarterly&as_user=x' });
    expect(other.statusCode).toBe(500);
    await app.close();
  });

  it('GET /search: behind its access check, in staff scope, q never logged', async () => {
    const lines: string[] = [];
    const logger = {
      info: (fields: object, msg: string) => void lines.push(JSON.stringify({ ...fields, msg })),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    const app = Fastify();
    let checked = 0;
    await app.register(searchPlugin, {
      requireAccess: async () => {
        checked += 1;
      },
      search: { ...deps(db), logger: logger as never },
    });
    const ok = await app.inject({
      method: 'GET',
      url: '/search?q=quarterly%20planning&type=session&limit=5',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((ok.json() as { data: unknown[] }).data).toHaveLength(2);
    expect(checked).toBe(1);
    const short = await app.inject({ method: 'GET', url: '/search?q=q' });
    expect(short.statusCode).toBe(422);
    expect(lines).toEqual([
      JSON.stringify({ q_length: 18, types: 'session', msg: 'search.query' }),
    ]);
    expect(lines.join(' ')).not.toContain('quarterly');
    await app.close();
  });
});
