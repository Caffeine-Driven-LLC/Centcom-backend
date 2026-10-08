// @vitest-environment node
/**
 * The admin console's build and source rules (B088), checked on a real `vite build`:
 *
 * - `index.html` carries exactly the card's CSP, with the admin API's origin in `connect-src`;
 * - nothing in the build loads from a third-party origin: no external script, style, font or image,
 *   no URL but the admin API's (XML namespace names and React's error-page text are identifiers,
 *   never fetched);
 * - the initial JavaScript is at most 250 KiB gzipped; no source maps, no inline scripts or styles;
 * - no `dangerouslySetInnerHTML` (or other raw HTML) anywhere in the console's source, and the lint
 *   rule refuses it.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ESLint } from 'eslint';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminViteConfig, checkApiBase, contentSecurityPolicy } from '../vite.config.js';

const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const ORIGIN = 'https://admin-api.internal:8081';
/** Strings in React's bundle that look like URLs but are never requested. */
const NOT_LOADED = [
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/XML/1998/namespace',
  'https://react.dev/errors/',
];

let out = '';
let files: { path: string; text: string; bytes: Buffer }[] = [];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]),
    ),
  );
  return paths.flat();
}

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'centcom-admin-build-'));
  await build({
    ...adminViteConfig({ apiBase: `${ORIGIN}/`, outDir: out }),
    configFile: false,
    logLevel: 'silent',
  });
  files = await Promise.all(
    (await walk(out)).map(async (path) => {
      const bytes = await readFile(path);
      return { path: relative(out, path).replace(/\\/g, '/'), text: bytes.toString('utf8'), bytes };
    }),
  );
}, 60_000);

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

const indexHtml = (): string => files.find((f) => f.path === 'index.html')?.text ?? '';

describe('the built page', () => {
  it('has exactly the card CSP, naming the admin API origin', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(
      indexHtml(),
    )?.[1];
    expect(csp).toBe(
      `default-src 'self'; script-src 'self'; connect-src 'self' ${ORIGIN}; frame-ancestors 'none'`,
    );
    expect(contentSecurityPolicy('')).toBe(
      "default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  it('loads nothing from a third-party origin and has no inline script or style', () => {
    const html = indexHtml();
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref, ref).toMatch(/^\/assets\//);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b|\bstyle="/);
    const urls = files.flatMap((f) =>
      [...f.text.matchAll(/https?:\/\/[^\s"'`)<>;]+/g)].map((m) => m[0]),
    );
    const foreign = urls.filter((u) => u !== ORIGIN && !NOT_LOADED.includes(u));
    expect(foreign).toEqual([]);
    for (const f of files.filter((x) => x.path.endsWith('.css'))) {
      expect(f.text, f.path).not.toMatch(/@import|url\(\s*['"]?(https?:|\/\/|data:)/);
    }
    expect(files.filter((f) => f.path.endsWith('.map'))).toEqual([]);
    expect(files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f.path))).toEqual([]);
  });

  it('keeps the initial JavaScript within 250 KiB gzipped', () => {
    const scripts = [...indexHtml().matchAll(/<script[^>]*src="\/([^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );
    expect(scripts.length).toBe(1);
    const initial = files.filter(
      (f) =>
        scripts.includes(f.path) || (f.path.endsWith('.js') && indexHtml().includes(`/${f.path}`)),
    );
    const gzipped = initial.reduce((sum, f) => sum + gzipSync(f.bytes).length, 0);
    expect(gzipped).toBeGreaterThan(0);
    expect(gzipped).toBeLessThanOrEqual(250 * 1024);
  });

  it('accepts only an http(s) admin API base without credentials, query or fragment', () => {
    expect(checkApiBase('https://admin.internal:8081/')).toBe('https://admin.internal:8081');
    for (const bad of [
      'ftp://admin.internal',
      'admin.internal',
      'https://u:p@admin.internal',
      'https://a.internal/?x=1',
      'https://a.internal/#x',
    ]) {
      expect(() => checkApiBase(bad), bad).toThrow(/VITE_ADMIN_API_BASE/);
    }
  });
});

describe('the source', () => {
  it('has no raw HTML rendering anywhere in the console', async () => {
    const sources = (await walk(join(APP, 'src'))).filter((p) => /\.(ts|tsx)$/.test(p));
    expect(sources.length).toBeGreaterThan(10);
    for (const path of sources) {
      const text = await readFile(path, 'utf8');
      expect(text, path).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie/,
      );
    }
  });

  it(
    'is linted against dangerouslySetInnerHTML, raw HTML, eval and browser storage',
    { timeout: 60_000 },
    async () => {
      const eslint = new ESLint({ cwd: REPO });
      const probe = join(REPO, 'apps/admin/src/probe.tsx');
      // Snippets the lint rules must refuse: linted as text, never run or written to disk.
      const cases = [
        'export const A = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;',
        'export function f(el: HTMLElement, s: string) { el.innerHTML = s; }',
        'export function f(s: string) { document.write(s); }',
        'export const t = localStorage.getItem("token");',
        'export const t = window.sessionStorage;',
        'export const c = document.cookie;',
        'export const v = eval("1");',
      ];
      for (const code of cases) {
        const [result] = await eslint.lintText(code, { filePath: probe });
        expect(result?.messages.filter((m) => m.severity === 2).length ?? 0, code).toBeGreaterThan(
          0,
        );
      }
      const [clean] = await eslint.lintText(
        'export const A = ({ text }: { text: string }) => <p>{text}</p>;',
        {
          filePath: probe,
        },
      );
      expect(clean?.messages ?? []).toEqual([]);
    },
  );
});
