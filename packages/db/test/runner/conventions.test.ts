/**
 * Migration conventions (B007, CONVENTIONS.md): every file in packages/db/migrations ends with a
 * `-- rollback note:` comment and keeps DROP TABLE, DROP COLUMN and TRUNCATE after a `-- contract`
 * phase marker, with no transaction control and no CONCURRENTLY index builds. The linter itself is
 * checked on good and bad samples, so an empty migrations directory still proves something.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintMigration, MIGRATIONS_DIR } from '../../src/index.js';
import { runCli } from '../../src/cli.js';
import { FIXTURES, scratchDir } from './helpers.js';

const NAME = '20260101000000_sample.sql';
const NOTE = '\n-- rollback note: drop the table by hand.\n';

/** Every .sql file of a directory, as [name, text]. */
async function sqlFiles(dir: string): Promise<[string, string][]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (n) => [n, await readFile(join(dir, n), 'utf8')] as [string, string]),
  );
}

describe('the migrations in this package', () => {
  it('all follow the conventions', async () => {
    for (const [name, text] of await sqlFiles(MIGRATIONS_DIR)) {
      expect(lintMigration(name, text), name).toEqual([]);
    }
  });

  it('as do the test fixtures', async () => {
    for (const dir of Object.values(FIXTURES)) {
      for (const [name, text] of await sqlFiles(dir))
        expect(lintMigration(name, text), name).toEqual([]);
    }
  });
});

describe('lintMigration', () => {
  it('accepts an additive migration with its rollback note', () => {
    const text = `create table a (id text primary key);\ncreate index a_id_idx on a (id);\n${NOTE}`;
    expect(lintMigration(NAME, text)).toEqual([]);
  });

  it('checks the file name', () => {
    expect(lintMigration('0001_sample.sql', `select 1;${NOTE}`)).toEqual([
      expect.stringContaining('<yyyymmddhhmmss>_<snake_name>.sql'),
    ]);
  });

  describe('the rollback note', () => {
    it('must close the file', () => {
      expect(lintMigration(NAME, 'create table a (id int);\n')).toEqual([
        expect.stringContaining('rollback note'),
      ]);
      // A note followed by more SQL is not the closing comment.
      expect(lintMigration(NAME, `${NOTE}create table a (id int);\n`)).toEqual([
        expect.stringContaining('rollback note'),
      ]);
    });

    it('must say something', () => {
      expect(lintMigration(NAME, 'create table a (id int);\n-- rollback note:\n')).toHaveLength(1);
      expect(lintMigration(NAME, 'create table a (id int);\n-- rollback note:   \n')).toHaveLength(
        1,
      );
    });

    it('may sit among other closing comments, in any case, with CRLF line ends', () => {
      const text =
        'create table a (id int);\r\n\r\n-- Rollback Note: drop table a.\r\n-- (after the contract release)\r\n';
      expect(lintMigration(NAME, text)).toEqual([]);
    });
  });

  describe('destructive statements', () => {
    it.each([
      ['drop table a;', 'DROP TABLE'],
      ['DROP TABLE IF EXISTS a, b CASCADE;', 'DROP TABLE'],
      ['alter table a drop column b;', 'DROP COLUMN'],
      ['alter table only a drop column if exists b;', 'DROP COLUMN'],
      ['alter table a drop b;', 'DROP COLUMN'],
      ['alter table a add column c int, drop b;', 'DROP COLUMN'],
      ['alter table "Odd Name" drop column b;', 'DROP COLUMN'],
      ['truncate a;', 'TRUNCATE'],
    ])('%s needs a contract marker', (statement, kind) => {
      const problems = lintMigration(NAME, `create table z (id int);\n${statement}\n${NOTE}`);
      expect(problems).toEqual([
        `line 2: ${kind} is destructive and belongs after a "-- contract" phase marker`,
      ]);
      expect(
        lintMigration(NAME, `create table z (id int);\n-- contract\n${statement}\n${NOTE}`),
      ).toEqual([]);
    });

    it('counts only statements after the marker as contract phase', () => {
      const text = `drop table early;\n-- contract: the code stopped using these in 1.4\ndrop table later;\n${NOTE}`;
      expect(lintMigration(NAME, text)).toEqual([
        'line 1: DROP TABLE is destructive and belongs after a "-- contract" phase marker',
      ]);
    });

    it('leaves column changes that keep the column alone', () => {
      const text = [
        'alter table a alter column b drop default;',
        'alter table a alter column b drop not null;',
        'alter table a drop constraint a_b_check;',
        'alter table a alter b drop expression;',
        'drop index a_b_idx;',
        NOTE,
      ].join('\n');
      expect(lintMigration(NAME, text)).toEqual([]);
    });

    it('ignores the words inside comments, strings and function bodies', () => {
      const text = [
        '-- we do not drop table a here',
        '/* drop table a; /* nested */ still a comment */',
        "insert into notes (body) values ('drop table a; truncate b;');",
        "insert into notes (body) values (E'it''s \\' drop table a');",
        'create function f() returns void language plpgsql as $body$',
        'begin',
        '  drop table temp_rows;',
        'end;',
        '$body$;',
        'do $$ begin truncate c; end $$;',
        NOTE,
      ].join('\n');
      expect(lintMigration(NAME, text)).toEqual([]);
    });
  });

  it('forbids transaction control, which would end the runner transaction', () => {
    for (const statement of [
      'begin;',
      'BEGIN TRANSACTION;',
      'start transaction;',
      'commit;',
      'end;',
      'rollback;',
      'abort;',
    ]) {
      expect(
        lintMigration(NAME, `${statement}\ncreate table a (id int);\n${NOTE}`),
        statement,
      ).toEqual(['line 1: no transaction control; the runner wraps the file in a transaction']);
    }
  });

  it('forbids CONCURRENTLY index builds, which cannot run in a transaction', () => {
    for (const statement of [
      'create index concurrently a_b_idx on a (b);',
      'create unique index concurrently a_b_key on a (b);',
      'drop index concurrently a_b_idx;',
      'reindex index concurrently a_b_idx;',
    ]) {
      expect(lintMigration(NAME, `${statement}\n${NOTE}`), statement).toEqual([
        "line 1: CONCURRENTLY cannot run inside the runner's transaction",
      ]);
    }
    // REFRESH ... CONCURRENTLY runs fine in a transaction.
    expect(lintMigration(NAME, `refresh materialized view concurrently m;\n${NOTE}`)).toEqual([]);
  });

  it('reports every problem with its line', () => {
    const text = 'create table a (id int);\nbegin;\n\ndrop table b;\n';
    expect(lintMigration('bad.sql', text)).toEqual([
      expect.stringContaining('<yyyymmddhhmmss>_<snake_name>.sql'),
      expect.stringContaining('rollback note'),
      'line 2: no transaction control; the runner wraps the file in a transaction',
      'line 4: DROP TABLE is destructive and belongs after a "-- contract" phase marker',
    ]);
  });
});

describe('centcom-db new', () => {
  it('writes a file that fails the lint until its rollback note is filled in', async () => {
    const { dir, remove } = await scratchDir();
    try {
      const now = () => new Date('2026-10-07T04:05:06.789Z');
      const code = await runCli(['new', 'add_widgets', '--dir', dir], {
        now,
        out: () => {},
        err: () => {},
      });
      expect(code).toBe(0);
      const [[name, text] = ['', '']] = await sqlFiles(dir);
      expect(name).toBe('20261007040506_add_widgets.sql');
      expect(lintMigration(name, text)).toEqual([expect.stringContaining('rollback note')]);
      const filled = text.replace('-- rollback note:', '-- rollback note: drop table widgets.');
      expect(lintMigration(name, `create table widgets (id text primary key);\n${filled}`)).toEqual(
        [],
      );
    } finally {
      await remove();
    }
  });
});
