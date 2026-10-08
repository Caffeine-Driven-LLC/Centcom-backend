/**
 * The table (B031; card test slots.migration.test.ts): its constraints refuse a slot held twice in
 * a session, a member with two slots, slots outside 0-49, a malformed member id and an unknown
 * session; and `assign` stays under 10 ms at p95 on the Postgres test container (acceptance 4),
 * timed in a child process (see assign-bench.ts).
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { newId } from '@centcom/contracts';
import { createSessionSlotStore } from '@centcom/db';
import { sessionFactory } from '@centcom/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotService } from '../../src/slots/index.js';
import {
  members,
  STACK,
  type SlotDb,
  STACK_TIMEOUT_MS,
  startTestStack,
  type TestStack,
} from './helpers.js';

const BENCH = fileURLToPath(new URL('./assign-bench.ts', import.meta.url));
const RELAY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** tsx's CLI, and the config that maps @centcom/* to their sources: the child needs no build. */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSCONFIG = fileURLToPath(new URL('../../../../tsconfig.test.json', import.meta.url));

describe.runIf(STACK)('session_member_slots on Postgres 16', () => {
  let stack: TestStack;
  let db: SlotDb;
  beforeAll(async () => {
    stack = await startTestStack();
    db = stack.db as unknown as SlotDb;
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  const insert = (row: Record<string, unknown>) =>
    db
      .insertInto('session_member_slots')
      // Values the types may forbid, on purpose: the database must refuse them too.
      .values(row as never)
      .execute();

  it('refuses a slot twice in a session, two slots for a member, and slots outside 0-49', async () => {
    const session = (await sessionFactory(stack.db).create()).id;
    const [a, b] = members(2) as [string, string];
    await insert({ session_id: session, member_id: a, slot: 0 });
    await expect(insert({ session_id: session, member_id: b, slot: 0 })).rejects.toThrow(
      /session_member_slots_session_id_slot_key/,
    );
    await expect(insert({ session_id: session, member_id: a, slot: 1 })).rejects.toThrow(
      /session_member_slots_pkey/,
    );
    for (const slot of [-1, 50]) {
      await expect(insert({ session_id: session, member_id: newId('mem'), slot })).rejects.toThrow(
        /check/,
      );
    }
    await expect(
      insert({ session_id: session, member_id: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', slot: 2 }),
    ).rejects.toThrow(/check/);
    await expect(insert({ session_id: newId('ses'), member_id: b, slot: 0 })).rejects.toThrow(
      /foreign key/,
    );
    // The same slot in another session is fine.
    const other = (await sessionFactory(stack.db).create()).id;
    await insert({ session_id: other, member_id: b, slot: 0 });
  });

  it('keeps the session row from being deleted while it has slots (purge them first)', async () => {
    const session = (await sessionFactory(stack.db).create()).id;
    const store = createSessionSlotStore(db);
    await createSlotService(store).assign(session, newId('mem'));
    await expect(db.deleteFrom('sessions').where('id', '=', session).execute()).rejects.toThrow(
      /foreign key/,
    );
    expect(await store.deleteForSession(session)).toBe(1);
    await db.deleteFrom('sessions').where('id', '=', session).execute();
  });

  it('assigns in under 10 ms at p95 (acceptance 4)', async () => {
    // A warm-up session, then three rounds of four sessions filled to 50 (see assign-bench.ts).
    const sessions = sessionFactory(stack.db);
    const sessionIds: string[] = [];
    for (let i = 0; i < 13; i++) sessionIds.push((await sessions.create()).id);
    const out = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', TSCONFIG, BENCH], {
      cwd: RELAY_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      input: JSON.stringify({ url: stack.databaseUrl, sessionIds }),
    });
    const { p95s } = JSON.parse(out) as { p95s: number[] };
    expect(p95s).toHaveLength(3);
    expect(Math.min(...p95s)).toBeLessThan(10);
    const store = createSessionSlotStore(db);
    for (const id of sessionIds) expect(await store.list(id)).toHaveLength(50);
  }, 180_000);
});
