/**
 * withTransaction (B007 acceptance 5): commit and rollback, up to 3 retries on a serialization
 * failure (SQLSTATE 40001) and then the error, no retry for anything else, isolation levels, and
 * nesting refused. Against the in-memory fake always, and against a real Postgres 16 (a forced
 * 40001 raised by the server) when DATABASE_URL is set.
 */
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  isSerializationFailure,
  MAX_SERIALIZATION_RETRIES,
  withTransaction,
} from '../../src/index.js';
import { FakePostgres } from './fake-postgres.js';
import { ADMIN_URL, onDatabase, tempDatabase } from './helpers.js';

type Db = Kysely<Record<string, never>>;

describe('withTransaction (fake database)', () => {
  const setup = (): { server: FakePostgres; db: Db } => {
    const server = new FakePostgres();
    return { server, db: server.connect() };
  };

  it("commits and returns fn's result", async () => {
    const { server, db } = setup();
    const result = await withTransaction(db, async (trx) => {
      await sql`insert into notes values (1)`.execute(trx);
      return 42;
    });
    expect(result).toBe(42);
    expect(server.committed).toEqual(['insert into notes values (1)']);
    expect(server.rollbacks).toBe(0);
  });

  it('rolls back and rethrows any other error without retrying', async () => {
    const { server, db } = setup();
    let attempts = 0;
    const boom = new Error('boom');
    await expect(
      withTransaction(db, async (trx) => {
        attempts += 1;
        await sql`insert into notes values (1)`.execute(trx);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(attempts).toBe(1);
    expect(server.committed).toEqual([]);
    expect(server.rollbacks).toBe(1);
  });

  it('does not retry a deadlock or a unique violation', async () => {
    for (const code of ['40P01', '23505']) {
      const { server, db } = setup();
      server.failOn('work', code);
      let attempts = 0;
      await expect(
        withTransaction(db, async (trx) => {
          attempts += 1;
          await sql`select 'work'`.execute(trx);
        }),
      ).rejects.toMatchObject({ code });
      expect(attempts, code).toBe(1);
    }
  });

  it('retries a serialization failure and commits once it goes through', async () => {
    const { server, db } = setup();
    server.failOn('work', '40001', 2);
    let attempts = 0;
    const result = await withTransaction(db, async (trx) => {
      attempts += 1;
      await sql`select 'work'`.execute(trx);
      return attempts;
    });
    expect(result).toBe(3);
    expect(server.rollbacks).toBe(2);
    expect(server.committed).toEqual(["select 'work'"]);
  });

  it(`gives up after ${MAX_SERIALIZATION_RETRIES} retries and rethrows the failure`, async () => {
    const { server, db } = setup();
    server.failOn('work', '40001');
    let attempts = 0;
    const err = await withTransaction(db, async (trx) => {
      attempts += 1;
      await sql`select 'work'`.execute(trx);
    }).catch((e: unknown) => e);
    expect(isSerializationFailure(err)).toBe(true);
    expect(attempts).toBe(1 + MAX_SERIALIZATION_RETRIES);
    expect(server.rollbacks).toBe(1 + MAX_SERIALIZATION_RETRIES);
  });

  it('retries a serialization failure raised by the commit itself', async () => {
    const { server, db } = setup();
    server.commitFailures = 1;
    let attempts = 0;
    await withTransaction(db, async () => {
      attempts += 1;
    });
    expect(attempts).toBe(2);
  });

  it('sets the isolation level asked for', async () => {
    const { server, db } = setup();
    await withTransaction(db, async () => undefined);
    await withTransaction(db, async () => undefined, { isolation: 'serializable' });
    await withTransaction(db, async () => undefined, { isolation: 'repeatable read' });
    expect(server.isolationLevels).toEqual(['default', 'serializable', 'repeatable read']);
  });

  describe('nesting', () => {
    it('refuses a transaction passed as the database', async () => {
      const { server, db } = setup();
      await withTransaction(db, async (trx) => {
        await expect(withTransaction(trx, async () => 1)).rejects.toThrow(TypeError);
      });
      expect(server.isolationLevels).toHaveLength(1);
    });

    it('refuses a second transaction opened from inside the first', async () => {
      const { db } = setup();
      const inner = await withTransaction(db, async () =>
        withTransaction(db, async () => 1).catch((e: unknown) => e),
      );
      expect(inner).toBeInstanceOf(TypeError);
      expect(String(inner)).toMatch(/cannot be nested/);
    });

    it('allows a transaction from work that runs after the first one ended', async () => {
      const { db } = setup();
      let later: Promise<number> | undefined;
      await withTransaction(db, async () => {
        later = new Promise((resolve, reject) => {
          setTimeout(() => {
            withTransaction(db, async () => 7).then(resolve, reject);
          }, 10);
        });
      });
      expect(await later).toBe(7);
    });

    it('allows independent transactions side by side', async () => {
      const { db } = setup();
      const results = await Promise.all([1, 2, 3].map((n) => withTransaction(db, async () => n)));
      expect(results).toEqual([1, 2, 3]);
    });
  });

  it('isSerializationFailure looks at the SQLSTATE only', () => {
    expect(isSerializationFailure(Object.assign(new Error('x'), { code: '40001' }))).toBe(true);
    for (const value of [
      new Error('40001'),
      { code: '40P01' },
      { code: 40001 },
      null,
      undefined,
      '40001',
    ]) {
      expect(isSerializationFailure(value)).toBe(false);
    }
  });
});

describe.runIf(ADMIN_URL !== undefined)('withTransaction (Postgres 16)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function database(): Promise<{ url: string; db: Db }> {
    const { url, drop } = await tempDatabase();
    const db = createDb<Record<string, never>>({ url });
    cleanups.push(drop, () => closeDb(db));
    await onDatabase(url, (c) => c.query('create table notes (n int not null)'));
    return { url, db };
  }

  /** Makes Postgres itself raise SQLSTATE 40001 when `attempt` is below `failures`. */
  const forceFailure = (trx: Db, attempt: number, failures: number) =>
    sql`
      do $$ begin
        if ${sql.lit(attempt)} < ${sql.lit(failures)} then
          raise exception 'forced' using errcode = 'serialization_failure';
        end if;
      end $$
    `.execute(trx);

  const count = (url: string): Promise<number> =>
    onDatabase(url, async (c) =>
      Number((await c.query('select count(*) as n from notes')).rows[0].n),
    );

  it('retries a forced 40001 up to 3 times and then rethrows it (acceptance 5)', async () => {
    const { url, db } = await database();
    let attempts = 0;
    const err = await withTransaction(db, async (trx) => {
      await sql`insert into notes (n) values (${attempts})`.execute(trx);
      attempts += 1;
      await forceFailure(trx, attempts - 1, 1_000);
    }).catch((e: unknown) => e);
    expect(attempts).toBe(4);
    expect(err).toMatchObject({ code: '40001' });
    expect(await count(url)).toBe(0);
  });

  it('commits the attempt that goes through, once', async () => {
    const { url, db } = await database();
    let attempts = 0;
    await withTransaction(db, async (trx) => {
      await sql`insert into notes (n) values (${attempts})`.execute(trx);
      attempts += 1;
      await forceFailure(trx, attempts - 1, 2);
    });
    expect(attempts).toBe(3);
    expect(await count(url)).toBe(1);
  });

  it('rolls back on any other error', async () => {
    const { url, db } = await database();
    await expect(
      withTransaction(db, async (trx) => {
        await sql`insert into notes (n) values (1)`.execute(trx);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await count(url)).toBe(0);
  });

  it('runs at the isolation level asked for', async () => {
    const { db } = await database();
    const level = await withTransaction(
      db,
      async (trx) =>
        (
          await sql<{
            level: string;
          }>`select current_setting('transaction_isolation') as level`.execute(trx)
        ).rows[0]?.level,
      { isolation: 'serializable' },
    );
    expect(level).toBe('serializable');
  });
});
