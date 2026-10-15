#!/usr/bin/env node
// Refuses migrations that would break the release still serving traffic (B092, expand/contract).
//
//   node infra/deploy/migration-lint.mjs <file.sql>...     (or SQL on stdin with --stdin <name>)
//
// The old code keeps running while a release's migrations apply, and a code rollback leaves the
// schema as it is, so every migration must work with the previous release. Refused:
//
//   drop-column        ALTER TABLE ... DROP COLUMN          (allowed after a "-- contract" marker)
//   drop-table         DROP TABLE                            (allowed after a "-- contract" marker)
//   rename             ALTER TABLE ... RENAME (column, table or constraint): never; add, copy, drop
//   not-null-no-default  ADD COLUMN ... NOT NULL without DEFAULT (old code inserts without it)
//   set-not-null       ALTER COLUMN ... SET NOT NULL         (allowed after a "-- contract" marker,
//                      once a backfill release has run)
//   alter-type         ALTER COLUMN ... TYPE                 (rewrites the table, may break readers)
//   index-lock         CREATE INDEX on a table this file did not create: it takes a write lock for
//                      the whole build. The runner wraps each file in a transaction, so CONCURRENTLY
//                      is not possible; acknowledge a small table with a line
//                      "-- deploy-lint: allow index-lock <table> (<why>)".
//
// Exit codes: 0 every file passes; 1 a file is refused (each problem printed as
// file:line: rule: text); 2 usage.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT_MARKER = /^\s*--\s*contract\b/i;
const ALLOW_INDEX = /^\s*--\s*deploy-lint:\s*allow\s+index-lock\s+("?[a-z_][a-z0-9_.]*"?)/i;

/**
 * Text with comments and quoted strings blanked out (newlines kept, so line numbers hold).
 * @param {string} text
 * @returns {string}
 */
function blank(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '--') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (text[i] === "'") {
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'"))
        j += text[j] === "'" ? 2 : 1;
      out += text.slice(i, j + 1).replace(/[^\n]/g, ' ');
      i = j + 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/**
 * The statements of `text`, each with the line it starts on, in upper case and one-spaced.
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
function statements(text) {
  const clean = blank(text);
  const result = [];
  let start = 0;
  for (let i = 0; i <= clean.length; i += 1) {
    if (i === clean.length || clean[i] === ';') {
      const raw = clean.slice(start, i);
      const lead = raw.length - raw.trimStart().length;
      const body = raw.trim();
      if (body !== '') {
        const line = clean.slice(0, start + lead).split('\n').length;
        result.push({ line, text: body.replace(/\s+/g, ' ').toUpperCase() });
      }
      start = i + 1;
    }
  }
  return result;
}

/** @param {string} name */
const unquote = (name) =>
  name
    .replace(/"/g, '')
    .toLowerCase()
    .replace(/^public\./, '');

/**
 * @typedef {{ file: string, line: number, rule: string, detail: string }} LintProblem
 */

/**
 * The problems of one migration `text` named `name`.
 * @param {string} name
 * @param {string} text
 * @returns {LintProblem[]}
 */
export function lintSql(name, text) {
  const lines = text.split('\n');
  const contractLine = lines.findIndex((l) => CONTRACT_MARKER.test(l)) + 1;
  /** @param {number} line */
  const afterContract = (line) => contractLine > 0 && line > contractLine;
  const allowedIndex = new Set(
    lines
      .map((l) => ALLOW_INDEX.exec(l)?.[1] ?? '')
      .filter((t) => t !== '')
      .map(unquote),
  );
  /** @type {Set<string>} */
  const created = new Set();
  /** @type {LintProblem[]} */
  const problems = [];
  /** @type {(line: number, rule: string, detail: string) => void} */
  const add = (line, rule, detail) => {
    problems.push({ file: name, line, rule, detail });
  };
  for (const { line, text: s } of statements(text)) {
    const table = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?("?[\w.]+"?)/.exec(s);
    if (table) created.add(unquote(table[1] ?? ''));

    if (/^DROP TABLE\b/.test(s) && !afterContract(line)) {
      add(
        line,
        'drop-table',
        'DROP TABLE belongs after a "-- contract" marker, in a later release',
      );
    }
    if (/^ALTER TABLE\b/.test(s)) {
      if (/\bRENAME\b/.test(s)) {
        add(
          line,
          'rename',
          'renaming breaks the release still running: add the new name, copy, drop later',
        );
      }
      if (
        /\bDROP (COLUMN\b|(?!CONSTRAINT|DEFAULT|NOT NULL|IDENTITY|EXPRESSION)"?\w)/.test(s) &&
        !afterContract(line)
      ) {
        add(
          line,
          'drop-column',
          'DROP COLUMN belongs after a "-- contract" marker, in a later release',
        );
      }
      for (const clause of s.split(/,(?![^(]*\))/)) {
        const added = /\bADD (?:COLUMN )?(?:IF NOT EXISTS )?"?\w+"? (.*)$/.exec(clause.trim());
        const def = added?.[1] ?? '';
        if (added && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/.test(def)) {
          if (/\bNOT NULL\b/.test(def) && !/\bDEFAULT\b/.test(def) && !/\bGENERATED\b/.test(def)) {
            add(
              line,
              'not-null-no-default',
              'a NOT NULL column needs a DEFAULT, or the old code’s inserts fail',
            );
          }
        }
      }
      if (/\bALTER (?:COLUMN )?"?\w+"? SET NOT NULL\b/.test(s) && !afterContract(line)) {
        add(
          line,
          'set-not-null',
          'SET NOT NULL belongs after a backfill release, behind a "-- contract" marker',
        );
      }
      if (/\bALTER (?:COLUMN )?"?\w+"? (?:SET DATA )?TYPE\b/.test(s)) {
        add(
          line,
          'alter-type',
          'changing a column type rewrites the table and can break the old code',
        );
      }
    }
    const index =
      /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:"?\w+"? )?ON (?:ONLY )?("?[\w.]+"?)/.exec(
        s,
      );
    if (index) {
      const target = unquote(index[1] ?? '');
      if (!created.has(target) && !allowedIndex.has(target)) {
        add(
          line,
          'index-lock',
          `CREATE INDEX on ${target} (not created in this file) blocks its writes while it builds; ` +
            `acknowledge a small table with "-- deploy-lint: allow index-lock ${target} (why)"`,
        );
      }
    }
  }
  return problems;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  /** @type {string[]} */
  const files = [];
  /** @type {string | undefined} */
  let stdinName;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--stdin') stdinName = argv[++i] ?? '';
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write(
        readFileSync(new URL(import.meta.url))
          .toString()
          .split('\n')
          .slice(1, 23)
          .join('\n') + '\n',
      );
      return 0;
    } else files.push(argv[i] ?? '');
  }
  if (files.length === 0 && stdinName === undefined) {
    process.stderr.write('usage: migration-lint.mjs <file.sql>... | --stdin <name>\n');
    return 2;
  }
  /** @type {[string, string][]} */
  const inputs = files.map((f) => [basename(f), readFileSync(f, 'utf8')]);
  if (stdinName !== undefined) inputs.push([stdinName, readFileSync(0, 'utf8')]);
  const problems = inputs.flatMap(([name, text]) => lintSql(name, text));
  for (const p of problems) process.stderr.write(`${p.file}:${p.line}: ${p.rule}: ${p.detail}\n`);
  if (problems.length === 0)
    process.stdout.write(`migration-lint: ${inputs.length} file(s) safe for the running release\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
