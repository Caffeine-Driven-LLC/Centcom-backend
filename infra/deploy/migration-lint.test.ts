/**
 * The migration linter (B092 acceptance 3): table-driven, 12 SQL samples. Each unsafe change is
 * refused with its rule (drop column, rename, NOT NULL without a default, an index build on an
 * existing table, ...); additive migrations, and destructive steps after a "-- contract" marker,
 * pass. The command line exits 1 on a refusal, 0 on safe files, 2 on usage.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintSql } from './migration-lint.mjs';

const NOTE = '\n-- rollback note: by hand.\n';

const CASES: { name: string; sql: string; rules: string[] }[] = [
  { name: 'drop column', sql: 'alter table users drop column nickname;', rules: ['drop-column'] },
  {
    name: 'drop column, short form',
    sql: 'ALTER TABLE users DROP nickname;',
    rules: ['drop-column'],
  },
  {
    name: 'rename column',
    sql: 'alter table users rename column name to display_name;',
    rules: ['rename'],
  },
  { name: 'rename table', sql: 'alter table users rename to people;', rules: ['rename'] },
  {
    name: 'add NOT NULL column without a default',
    sql: 'alter table users add column plan text not null;',
    rules: ['not-null-no-default'],
  },
  {
    name: 'index on an existing table, without CONCURRENTLY',
    sql: 'create index users_plan_idx on users (plan);',
    rules: ['index-lock'],
  },
  {
    name: 'set not null',
    sql: 'alter table users alter column plan set not null;',
    rules: ['set-not-null'],
  },
  { name: 'drop table', sql: 'drop table legacy_tokens;', rules: ['drop-table'] },
  {
    name: 'additive: a new table with its index',
    sql: "create table notes (id text primary key, body text not null default '');\ncreate index notes_body_idx on notes (body);",
    rules: [],
  },
  {
    name: 'additive: a nullable column and a NOT NULL one with a default',
    sql: "alter table users add column bio text, add column tier text not null default 'free';",
    rules: [],
  },
  {
    name: 'a destructive step after the contract marker',
    sql: 'select 1;\n-- contract\nalter table users drop column nickname;',
    rules: [],
  },
  {
    name: 'an acknowledged index on a small table; DROP DEFAULT and DROP CONSTRAINT are not drops',
    sql:
      '-- deploy-lint: allow index-lock plans (12 rows, fixed by the seed)\n' +
      'create index plans_name_idx on plans (name);\n' +
      'alter table users alter column plan drop default, drop constraint users_plan_check;',
    rules: [],
  },
];

describe('migration-lint', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.rules.length === 0 ? 'passes' : c.rules.join(', ')}`, () => {
      const problems = lintSql('20270101000000_sample.sql', c.sql + NOTE);
      expect(problems.map((p) => p.rule)).toEqual(c.rules);
    });
  }

  it('ignores comments and strings, and reports the right line', () => {
    const sql =
      "-- drop table users;\ninsert into t values ('rename to');\n\nalter table users rename to x;";
    expect(lintSql('f.sql', sql)).toEqual([expect.objectContaining({ rule: 'rename', line: 4 })]);
  });

  it('the command line: exit 1 with file:line on a refusal, 0 when safe, 2 without input', () => {
    const script = join(import.meta.dirname, 'migration-lint.mjs');
    const bad = spawnSync('node', [script, '--stdin', 'x.sql'], {
      input: 'alter table users drop column a;',
      encoding: 'utf8',
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('x.sql:1: drop-column');
    const good = spawnSync('node', [script, '--stdin', 'y.sql'], {
      input: 'alter table users add column a text;',
      encoding: 'utf8',
    });
    expect(good.status).toBe(0);
    expect(spawnSync('node', [script], { encoding: 'utf8' }).status).toBe(2);
  });
});
