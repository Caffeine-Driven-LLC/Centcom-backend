/**
 * Test helpers for metadata search (B089): a Postgres 16 stack (B010's testkit: DATABASE_URL and
 * REDIS_URL, or a container runtime), the card's seed (10 000 workspaces, 50 000 users, 100 000
 * sessions, written with set-based SQL so it takes seconds), and search deps with a signing key.
 */
import { newId } from '@centcom/contracts';
import { defineConfig, Secret, z, type SigningKeys } from '@centcom/core';
import type { CoreDatabase } from '@centcom/db';
import { startTestStack, testcontainersRuntime, type TestStack } from '@centcom/testkit';
import { sql, type Kysely } from 'kysely';
import type { SearchDeps } from '../../src/modules/search/service.js';

const env = defineConfig(
  z.object({ DATABASE_URL: z.string().optional(), REDIS_URL: z.string().optional() }),
);
export const STACK =
  (env.DATABASE_URL !== undefined && env.REDIS_URL !== undefined) ||
  (await testcontainersRuntime.check().then(
    () => true,
    () => false,
  ));
export const STACK_TIMEOUT_MS = 180_000;
export { startTestStack, type TestStack };

export const KEYS: SigningKeys = [{ id: 'k1', secret: new Secret(Buffer.alloc(32, 7)) }];

export const deps = (db: Kysely<CoreDatabase>): SearchDeps => ({
  db,
  cursorKeys: KEYS,
  clock: () => Date.parse('2026-10-11T12:00:00.000Z'),
});

/** A 26-character id body from `n` (digits are in the CT-IDS alphabet). */
export const body = (n: number): string => String(n).padStart(26, '0');

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

/**
 * The card's seed: 10 000 workspaces, 50 000 users, 100 000 sessions named
 * `<word> sprint <n>` (ids `ses_000…n`), spread over the workspaces, newest first by `n`.
 */
export async function seedLarge(db: Kysely<CoreDatabase>): Promise<void> {
  // One transaction with no statement timeout: the bulk inserts can outlast the test database's
  // timeout on a loaded machine or a slow CI runner.
  await db.transaction().execute((trx) => seedLargeIn(trx));
}

async function seedLargeIn(db: Kysely<CoreDatabase>): Promise<void> {
  await sql`set local statement_timeout = 0`.execute(db);
  await sql`
    insert into users (id, email, display_name)
    select 'usr_' || lpad(i::text, 26, '0'), 'person' || i || '@example.test', 'Person ' || i
    from generate_series(1, 50000) i`.execute(db);
  await sql`
    insert into workspaces (id, name, slug, created_by)
    select 'wsp_' || lpad(i::text, 26, '0'), 'Team ' || i, 'team-' || i, 'usr_' || lpad('1', 26, '0')
    from generate_series(1, 10000) i`.execute(db);
  await sql`
    insert into sessions (id, workspace_id, name, state, region, created_by, created_at)
    select 'ses_' || lpad(i::text, 26, '0'),
      'wsp_' || lpad((i % 10000 + 1)::text, 26, '0'),
      (array[${sql.join(WORDS.map((w) => sql`${w}`))}])[i % 5 + 1] || ' sprint ' || i,
      case when i % 7 = 0 then 'ended' else 'live' end,
      'eu', 'usr_' || lpad('1', 26, '0'),
      timestamptz '2026-01-01' + (i || ' seconds')::interval
    from generate_series(1, 100000) i`.execute(db);
  await sql`analyze users, workspaces, sessions`.execute(db);
}

/** A small world: two workspaces with members and sessions, for scope tests. */
export async function seedSmall(db: Kysely<CoreDatabase>) {
  const user = async (name: string, email: string) => {
    const id = newId('usr');
    await db.insertInto('users').values({ id, email, display_name: name }).execute();
    return id;
  };
  const alice = await user(
    'Alice Example',
    `alice-${newId('req').slice(-6).toLowerCase()}@corp.test`,
  );
  const bob = await user('Bob Other', `bob-${newId('req').slice(-6).toLowerCase()}@corp.test`);
  const workspace = async (name: string, owner: string) => {
    const id = newId('wsp');
    await db
      .insertInto('workspaces')
      .values({
        id,
        name,
        slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${id.slice(-6).toLowerCase()}`,
        created_by: owner,
      })
      .execute();
    await db
      .insertInto('memberships')
      .values({ id: newId('mem'), workspace_id: id, user_id: owner, role: 'owner' })
      .execute();
    return id;
  };
  const ours = await workspace('Ours Studio', alice);
  const theirs = await workspace('Theirs Studio', bob);
  const session = async (wsp: string, name: string, by: string) => {
    const id = newId('ses');
    await db
      .insertInto('sessions')
      .values({ id, workspace_id: wsp, name, region: 'eu', created_by: by, state: 'live' })
      .execute();
    return id;
  };
  const oursSession = await session(ours, 'Quarterly planning ours', alice);
  const theirsSession = await session(theirs, 'Quarterly planning theirs', bob);
  return { alice, bob, ours, theirs, oursSession, theirsSession };
}
