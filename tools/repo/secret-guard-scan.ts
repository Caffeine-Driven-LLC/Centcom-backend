/**
 * `pnpm secret-guard:scan` (B101, surface 4): looks for provider credentials (the patterns of
 * contracts/fixtures/providers/secret-patterns.json) in the repository tree, a directory of log
 * files and a database dump, and prints where, never what.
 *
 *   tsx tools/repo/secret-guard-scan.ts [--root <dir>] [--dump <file>] [--logs <dir>] [--json]
 *
 * - The tree is the files git tracks under --root (every file, if --root is not a git checkout),
 *   minus binary files. Its allow-list is `<root>/secret-guard.allow.json` (scope `path`).
 * - --logs scans every file under a directory; --dump streams one file (any size) in 64 KiB windows.
 *   Neither uses the allow-list: a log or a dump has no business holding a credential.
 * - Output: `path:line pattern-id` (dump: `dump:byte-offset pattern-id`). Exit 0 clean, 1 hits, 2 usage.
 *
 * It lives here and not in tools/ci because that folder is protected; the workflow that calls it
 * (.github/workflows/secret-guard.yml in the card) is for a human to add.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { secretGuard } from '@centcom/core';

const USAGE = 'usage: secret-guard-scan [--root <dir>] [--dump <file>] [--logs <dir>] [--json]\n';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

interface Finding {
  where: string;
  pattern: string;
}

/** Tracked files under `root`, or every file when it is not a git checkout. */
function listFiles(root: string): string[] {
  const git = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (git.status === 0) {
    return git.stdout
      .toString('utf8')
      .split('\0')
      .filter((f) => f !== '' && existsSync(join(root, f)));
  }
  return walk(root, root);
}

function walk(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(root, join(dir, entry.name)));
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return out;
}

/** The text of a file as Latin-1 (byte-for-byte), or undefined for a binary or oversize file. */
function readText(file: string): string | undefined {
  if (statSync(file).size > MAX_FILE_BYTES) return undefined;
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  return bytes.toString('latin1');
}

/** Line number (1-based) of `offset` in `text`. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

function scanFiles(
  root: string,
  files: readonly string[],
  allow: secretGuard.AllowList,
): { findings: Finding[]; scanned: number } {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const rel of files) {
    const text = readText(join(root, rel));
    if (text === undefined) continue;
    scanned += 1;
    for (const hit of secretGuard.scanText(text, { allow, location: { path: rel } })) {
      findings.push({ where: `${rel}:${lineOf(text, hit.offset)}`, pattern: hit.pattern });
    }
  }
  return { findings, scanned };
}

async function main(argv: readonly string[]): Promise<number> {
  const opts = {
    root: '.',
    dump: undefined as string | undefined,
    logs: undefined as string | undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--root' || arg === '--dump' || arg === '--logs') {
      const value = argv[(i += 1)];
      if (value === undefined) return usage(`${arg} needs a value`);
      if (arg === '--root') opts.root = value;
      else opts[arg === '--dump' ? 'dump' : 'logs'] = value;
    } else return usage(`unknown argument ${arg ?? ''}`);
  }
  const root = resolve(opts.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) return usage('--root is not a directory');
  for (const path of [opts.dump, opts.logs]) {
    if (path !== undefined && !existsSync(path)) return usage(`${path} does not exist`);
  }

  const findings: Finding[] = [];
  let scanned = 0;
  try {
    const allowFile = join(root, 'secret-guard.allow.json');
    const allow = existsSync(allowFile)
      ? secretGuard.loadAllowListFile(allowFile)
      : secretGuard.EMPTY_ALLOW_LIST;
    const tree = scanFiles(root, listFiles(root), allow);
    findings.push(...tree.findings);
    scanned += tree.scanned;
    if (opts.logs !== undefined) {
      const logs = resolve(opts.logs);
      const result = scanFiles(logs, walk(logs, logs), secretGuard.EMPTY_ALLOW_LIST);
      findings.push(...result.findings.map((f) => ({ ...f, where: `logs/${f.where}` })));
      scanned += result.scanned;
    }
    if (opts.dump !== undefined) {
      const result = await secretGuard.scanBackupStream(createReadStream(opts.dump));
      findings.push(...result.hits.map((h) => ({ where: `dump:${h.offset}`, pattern: h.pattern })));
      scanned += 1;
    }
  } catch (err) {
    process.stderr.write(`secret-guard-scan: ${err instanceof Error ? err.message : 'failed'}\n`);
    return 2;
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(findings)}\n`);
  else for (const f of findings) process.stdout.write(`${f.where} ${f.pattern}\n`);
  process.stderr.write(
    findings.length === 0
      ? `secret-guard-scan: clean (${scanned} files or streams scanned)\n`
      : `secret-guard-scan: ${findings.length} hit(s); fix them or add a scoped, expiring entry to secret-guard.allow.json\n`,
  );
  return findings.length === 0 ? 0 : 1;
}

function usage(message: string): number {
  process.stderr.write(`secret-guard-scan: ${message}\n${USAGE}`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
