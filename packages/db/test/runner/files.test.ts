/**
 * Migration files without a database (B007): the naming rule, version order, checksums that ignore
 * CRLF and BOM, duplicate and invalid names, a missing directory, and the expected version.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectedMigrationVersion,
  migrationChecksum,
  MigrationError,
  MIGRATIONS_DIR,
  parseMigrationFileName,
  readMigrations,
} from '../../src/index.js';
import { FIXTURES, SAMPLE_VERSIONS, scratchDir } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function dirWith(files: Record<string, string>): Promise<string> {
  const { dir, remove } = await scratchDir();
  cleanups.push(remove);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

const FOOTER = '\n-- rollback note: nothing.\n';

describe('file names', () => {
  it('accepts <yyyymmddhhmmss>_<snake_name>.sql with a real UTC timestamp', () => {
    expect(parseMigrationFileName('20260101000000_core_schema.sql')).toEqual({
      version: '20260101000000',
      name: 'core_schema',
    });
    expect(parseMigrationFileName('20240229235959_leap_day_2.sql')?.version).toBe('20240229235959');
  });

  it('rejects anything else', () => {
    for (const name of [
      '20260101000000_core_schema.SQL',
      '20260101000000_Core_schema.sql',
      '20260101000000-core_schema.sql',
      '2026010100000_core_schema.sql',
      '20260101000000_.sql',
      '20260101000000_core__schema.sql',
      '20260101000000_core schema.sql',
      '20261301000000_bad_month.sql',
      '20250229000000_not_a_leap_year.sql',
      '20260101240000_bad_hour.sql',
      '20260101006000_bad_minute.sql',
      'core_schema.sql',
      '0001_core_schema.sql',
    ]) {
      expect(parseMigrationFileName(name), name).toBeUndefined();
    }
  });
});

describe('checksums', () => {
  it('are sha256 of the text, the same for LF, CRLF and a leading BOM', () => {
    const lf = 'create table a (id int);\n-- rollback note: drop table a.\n';
    expect(migrationChecksum(lf)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(migrationChecksum(lf.replace(/\n/g, '\r\n'))).toBe(migrationChecksum(lf));
    expect(migrationChecksum(`\uFEFF${lf}`)).toBe(migrationChecksum(lf));
  });

  it('change with any edit', () => {
    const text = 'create table a (id int);';
    expect(migrationChecksum(`${text} `)).not.toBe(migrationChecksum(text));
    expect(migrationChecksum(text.replace('a', 'b'))).not.toBe(migrationChecksum(text));
  });
});

describe('readMigrations', () => {
  it('returns the sample migrations in version order with their checksums', async () => {
    const files = await readMigrations(FIXTURES.sample);
    expect(files.map((f) => f.version)).toEqual([...SAMPLE_VERSIONS]);
    expect(files.map((f) => f.name)).toEqual([
      'create_widgets',
      'add_widget_color',
      'create_gadgets',
    ]);
    for (const f of files) {
      expect(f.fileName).toBe(`${f.version}_${f.name}.sql`);
      expect(f.checksum).toBe(migrationChecksum(f.sql));
    }
  });

  it('orders by version whatever order the files were written in, and ignores other files', async () => {
    const dir = await dirWith({
      '20260301000000_c.sql': `select 3;${FOOTER}`,
      'README.md': '# not a migration',
      '20260101000000_a.sql': `select 1;${FOOTER}`,
      'notes.txt': 'ignored',
      '20260201000000_b.sql': `select 2;${FOOTER}`,
    });
    expect((await readMigrations(dir)).map((f) => f.name)).toEqual(['a', 'b', 'c']);
  });

  it('normalises line ends and a BOM in the text it returns', async () => {
    const dir = await dirWith({ '20260101000000_a.sql': `\uFEFFselect 1;\r\nselect 2;\r\n` });
    const [file] = await readMigrations(dir);
    expect(file?.sql).toBe('select 1;\nselect 2;\n');
  });

  it('refuses a badly named .sql file', async () => {
    const dir = await dirWith({
      '20260101000000_ok.sql': 'select 1;',
      'add_users.sql': 'select 1;',
    });
    await expect(readMigrations(dir)).rejects.toMatchObject({
      name: 'MigrationError',
      code: 'invalid_name',
      message: expect.stringContaining('add_users.sql'),
    });
  });

  it('refuses two files with the same version', async () => {
    const dir = await dirWith({
      '20260101000000_a.sql': 'select 1;',
      '20260101000000_b.sql': 'select 2;',
    });
    const err = await readMigrations(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err).toMatchObject({ code: 'duplicate_version' });
  });

  it('reports a missing directory as missing_dir', async () => {
    const { dir, remove } = await scratchDir();
    await remove();
    await expect(readMigrations(dir)).rejects.toMatchObject({ code: 'missing_dir' });
  });
});

describe('expectedMigrationVersion', () => {
  it('is the newest file version of the directory', () => {
    expect(expectedMigrationVersion(FIXTURES.sample)).toBe(SAMPLE_VERSIONS[2]);
    expect(expectedMigrationVersion(FIXTURES.slow)).toBe('20260101000100');
    // This package's own migrations (B008 added the first).
    expect(expectedMigrationVersion(MIGRATIONS_DIR)).toMatch(/^\d{14}$/);
    expect(expectedMigrationVersion()).toBe(expectedMigrationVersion(MIGRATIONS_DIR));
  });

  it("is '' for a directory without migrations", async () => {
    const dir = await dirWith({ 'README.md': 'no migrations yet' });
    expect(expectedMigrationVersion(dir)).toBe('');
  });

  it('throws for a missing directory or a bad name', async () => {
    const { dir, remove } = await scratchDir();
    await remove();
    expect(() => expectedMigrationVersion(dir)).toThrow(MigrationError);
    const bad = await dirWith({ 'v2_users.sql': 'select 1;' });
    expect(() => expectedMigrationVersion(bad)).toThrow(/v2_users\.sql/);
  });
});
