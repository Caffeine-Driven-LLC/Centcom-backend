/**
 * Building links (B033, card test deeplink.build.test.ts): golden URLs for every row of the
 * CT-DEEPLINK table, read from the contract (acceptance 1); the web origin from WEB_BASE_URL; no
 * built URL carries `#`, and a token with `#` throws (acceptance 4); the fragment helpers, and no
 * server source that builds a `#k=` fragment.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertServerUrl,
  buildAuthCallbackUrl,
  buildBillingUrl,
  buildInviteUrl,
  buildJoinUrl,
  buildSessionUrl,
  buildShareUrl,
  ConfigError,
  deeplinkConfig,
  type LinkPair,
  parseDeepLink,
  withKeyFragment,
} from '../../src/index.js';
import { CODE, deeplinkTable, fill, SES, STATE, TOKEN } from './helpers.js';

/** Each row's builder, by the purpose the table gives it. */
const BUILDERS: Record<string, (focus?: 'approval' | 'queue') => Partial<LinkPair>> = {
  'Join a session': () => buildJoinUrl(TOKEN),
  'Open a session': (focus) => buildSessionUrl(SES, focus),
  'Auth callback (PKCE desktop)': () => ({ app: buildAuthCallbackUrl(CODE, STATE) }),
  'Upgrade / billing': () => buildBillingUrl(),
  'Accept workspace invite': () => buildInviteUrl(TOKEN),
  'Join as viewer guest (share link)': () => buildShareUrl(TOKEN),
};

describe('the CT-DEEPLINK table', () => {
  const rows = deeplinkTable();

  it('has the six rows this lane builds, and no other', () => {
    expect(rows.map((row) => row.purpose).sort()).toEqual(Object.keys(BUILDERS).sort());
  });

  it.each(rows)('builds "$purpose" exactly as the table writes it', (row) => {
    const build = BUILDERS[row.purpose];
    if (build === undefined) throw new Error(`no builder for ${row.purpose}`);
    const built = build();
    if (row.web === '—') expect(built.web).toBeUndefined();
    else expect(built.web).toBe(fill(row.web));
    expect(built.app).toBe(fill(row.app));
    if (row.app.includes('[?focus=approval|queue]')) {
      for (const focus of ['approval', 'queue'] as const) {
        expect(build(focus).app).toBe(fill(row.app, { focus }));
      }
    }
  });
});

describe('golden links', () => {
  it("builds buildJoinUrl('T') as https://centcom.dev/j/T and centcom://join/T (acceptance 1)", () => {
    expect(buildJoinUrl('T')).toEqual({ web: 'https://centcom.dev/j/T', app: 'centcom://join/T' });
  });

  it('builds the rest of the table', () => {
    expect(buildInviteUrl(TOKEN)).toEqual({
      web: `https://centcom.dev/i/${TOKEN}`,
      app: `centcom://invite/${TOKEN}`,
    });
    expect(buildShareUrl(TOKEN)).toEqual({
      web: `https://centcom.dev/g/${TOKEN}`,
      app: `centcom://share/${TOKEN}`,
    });
    expect(buildSessionUrl(SES)).toEqual({
      web: `https://centcom.dev/s/${SES}`,
      app: `centcom://session/${SES}`,
    });
    expect(buildSessionUrl(SES, 'approval').app).toBe(`centcom://session/${SES}?focus=approval`);
    expect(buildSessionUrl(SES, 'queue')).toEqual({
      web: `https://centcom.dev/s/${SES}`,
      app: `centcom://session/${SES}?focus=queue`,
    });
    expect(buildBillingUrl()).toEqual({
      web: 'https://centcom.dev/billing',
      app: 'centcom://billing',
    });
    expect(buildAuthCallbackUrl(CODE, STATE)).toBe(
      `centcom://auth/callback?code=${CODE}&state=${STATE}`,
    );
  });

  it('gives what parseDeepLink reads back as the same link, in both forms', () => {
    const cases = [
      [buildJoinUrl(TOKEN), { kind: 'join', token: TOKEN }],
      [buildInviteUrl(TOKEN), { kind: 'invite', token: TOKEN }],
      [buildShareUrl(TOKEN), { kind: 'share', token: TOKEN }],
      [buildBillingUrl(), { kind: 'billing' }],
      [buildSessionUrl(SES), { kind: 'session', sessionId: SES, focus: null }],
    ] as const;
    for (const [pair, expected] of cases) {
      expect(parseDeepLink(pair.web)).toEqual({ ok: true, form: 'web', ...expected });
      expect(parseDeepLink(pair.app)).toEqual({ ok: true, form: 'app', ...expected });
    }
    expect(parseDeepLink(buildSessionUrl(SES, 'queue').app)).toEqual({
      ok: true,
      kind: 'session',
      form: 'app',
      sessionId: SES,
      focus: 'queue',
    });
    expect(parseDeepLink(buildAuthCallbackUrl(CODE, STATE))).toEqual({
      ok: true,
      kind: 'auth_callback',
      form: 'app',
      code: CODE,
      state: STATE,
    });
  });
});

describe('the web origin (WEB_BASE_URL)', () => {
  it('defaults to https://centcom.dev', () => {
    expect(deeplinkConfig({})).toEqual({ webBase: 'https://centcom.dev' });
  });

  it('puts every web link on the configured origin, and leaves app links alone', () => {
    const { webBase } = deeplinkConfig({ WEB_BASE_URL: 'https://Staging.Centcom.dev:8443/' });
    expect(webBase).toBe('https://staging.centcom.dev:8443');
    expect(buildJoinUrl('T', webBase)).toEqual({
      web: 'https://staging.centcom.dev:8443/j/T',
      app: 'centcom://join/T',
    });
    expect(buildInviteUrl(TOKEN, webBase).web).toBe(`${webBase}/i/${TOKEN}`);
    expect(buildShareUrl(TOKEN, webBase).web).toBe(`${webBase}/g/${TOKEN}`);
    expect(buildSessionUrl(SES, 'approval', webBase)).toEqual({
      web: `${webBase}/s/${SES}`,
      app: `centcom://session/${SES}?focus=approval`,
    });
    expect(buildBillingUrl(webBase).web).toBe(`${webBase}/billing`);
    expect(parseDeepLink(`${webBase}/i/${TOKEN}`, { webBase })).toMatchObject({ kind: 'invite' });
    expect(parseDeepLink(`https://centcom.dev/i/${TOKEN}`, { webBase })).toEqual({ ok: false });
  });

  it.each([
    'http://centcom.dev',
    'centcom://join',
    'https://centcom.dev/app',
    'https://centcom.dev/?x=1',
    'https://centcom.dev/#k',
    'https://user:pw@centcom.dev',
    'not a url',
  ])('refuses %s at boot, and in a builder', (base) => {
    expect(() => deeplinkConfig({ WEB_BASE_URL: base })).toThrow(ConfigError);
    expect(() => buildJoinUrl('T', base)).toThrow(TypeError);
    expect(() => parseDeepLink(`https://centcom.dev/j/${TOKEN}`, { webBase: base })).toThrow(
      TypeError,
    );
  });
});

describe('no fragment in a built URL (acceptance 4)', () => {
  it('throws for a token, id, focus, code or state that is off the table', () => {
    for (const token of ['T#k=abc', '#', 'a b', 'a/b', 'a?b', '', 'é', 'x'.repeat(65)]) {
      expect(() => buildJoinUrl(token)).toThrow(TypeError);
      expect(() => buildInviteUrl(token)).toThrow(TypeError);
      expect(() => buildShareUrl(token)).toThrow(TypeError);
    }
    for (const id of [`${SES}#k=1`, 'ses_123', 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W', '']) {
      expect(() => buildSessionUrl(id)).toThrow(TypeError);
    }
    expect(() => buildSessionUrl(SES, 'other' as never)).toThrow(TypeError);
    expect(() => buildSessionUrl(SES, 'queue#k=1' as never)).toThrow(TypeError);
    expect(() => buildAuthCallbackUrl('c#k=1', STATE)).toThrow(TypeError);
    expect(() => buildAuthCallbackUrl(CODE, 's&next=https://evil.test')).toThrow(TypeError);
    expect(() => buildAuthCallbackUrl('', STATE)).toThrow(TypeError);
  });

  it('never puts # in any URL it builds', () => {
    const built = [
      buildJoinUrl(TOKEN),
      buildInviteUrl(TOKEN),
      buildShareUrl(TOKEN),
      buildSessionUrl(SES),
      buildSessionUrl(SES, 'approval'),
      buildBillingUrl(),
      { web: '', app: buildAuthCallbackUrl(CODE, STATE) },
    ].flatMap((pair) => [pair.web, pair.app]);
    for (const url of built) expect(url).not.toContain('#');
  });

  it('assertServerUrl passes a plain URL and throws for any fragment', () => {
    expect(assertServerUrl('https://centcom.dev/j/T')).toBe('https://centcom.dev/j/T');
    expect(() => assertServerUrl('https://centcom.dev/j/T#k=abc')).toThrow(TypeError);
    expect(() => assertServerUrl('https://centcom.dev/j/T#')).toThrow(TypeError);
  });

  it('withKeyFragment adds #k= for a test client, once, with a base64url key', () => {
    const url = buildJoinUrl(TOKEN).web;
    const shared = withKeyFragment(url, 'a2V5LW1hdGVyaWFs');
    expect(shared).toBe(`${url}#k=a2V5LW1hdGVyaWFs`);
    expect(() => withKeyFragment(shared, 'b')).toThrow(TypeError);
    expect(() => withKeyFragment(url, 'not base64url!')).toThrow(TypeError);
    expect(() => withKeyFragment(url, '')).toThrow(TypeError);
    // What a client shares is not a link the server accepts.
    expect(parseDeepLink(shared)).toEqual({ ok: false });
  });
});

describe('server sources', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
      return path.endsWith('.ts') ? [path] : [];
    });
  const serverFiles = ['apps', 'packages']
    .flatMap((top) => readdirSync(join(root, top)).map((name) => join(root, top, name, 'src')))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(sources);

  it('never call withKeyFragment or write a #k= fragment (the guardrail on key material)', () => {
    expect(serverFiles.length).toBeGreaterThan(50);
    const offenders = serverFiles
      .filter((file) => !file.endsWith(join('deeplink', 'fragment.ts')))
      .filter((file) => !file.endsWith(join('deeplink', 'index.ts')))
      .filter((file) => {
        const code = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .join('\n');
        return /withKeyFragment|#k=/.test(code);
      })
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
