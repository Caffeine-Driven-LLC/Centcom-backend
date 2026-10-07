/**
 * redact(): the key deny list, the value patterns, the string cap, cycles, the depth cap, exotic
 * objects, and never mutating its input (B005 acceptance 2, 3 and 7).
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_LOG_DEPTH,
  MAX_LOG_ENTRIES,
  MAX_LOG_STRING_LENGTH,
  REDACTED,
  redact,
  Secret,
  TRUNCATED,
  UNSERIALISABLE,
} from '../../src/index.js';
import { base62, JWE, JWT, LIVE_KEY, megabyteObject, REQUEST_ID, TEST_KEY } from './helpers.js';

const CORE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BENCH = fileURLToPath(new URL('./redact-bench.ts', import.meta.url));

/** The card's key deny list. */
const CARD_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'refresh_token',
  'access_token',
  'secret',
  'password',
  'api_key',
  'ct',
  'sig',
  'text',
  'p',
  'body',
  'path',
  'branch',
  'cwd',
  'device_code',
  'user_code',
  'code_verifier',
  'code',
];

/** An API key's id (CT-IDS `key_`), which is not a secret. */
const KEY_ID = REQUEST_ID.replace('req', 'key');

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

/** `levels` objects nested inside each other, with `leaf` at the bottom. */
const nest = (levels: number, leaf: unknown = 'leaf'): unknown => {
  let value = leaf;
  for (let i = 0; i < levels; i++) value = { next: value };
  return value;
};

/** The value `levels` steps down a `nest()` result. */
const descend = (value: unknown, levels: number): unknown => {
  let v = value;
  for (let i = 0; i < levels; i++) v = (v as { next: unknown }).next;
  return v;
};

describe('key deny list', () => {
  it('acceptance 2: redacts authorization and a nested refresh_token, keeps the other keys', () => {
    const out = redact({
      authorization: 'Bearer abc',
      nested: { refresh_token: 'x', kept: 'yes' },
      count: 3,
    });
    expect(out).toEqual({
      authorization: REDACTED,
      nested: { refresh_token: REDACTED, kept: 'yes' },
      count: 3,
    });
  });

  it.each(CARD_KEYS)('redacts %s at any depth, whatever its value', (key) => {
    const values = ['plain', 42, { inner: 'object' }, ['list'], null, true];
    for (const value of values) {
      expect(redact({ [key]: value })).toEqual({ [key]: REDACTED });
      expect(redact({ a: { b: [{ [key]: value }] } })).toEqual({ a: { b: [{ [key]: REDACTED }] } });
    }
  });

  it('ignores case, - and _ in key names', () => {
    for (const key of [
      'Authorization',
      'AUTHORIZATION',
      'refreshToken',
      'RefreshToken',
      'access-token',
      'API-KEY',
      'apiKey',
      'Set-Cookie',
      'deviceCode',
      'codeVerifier',
      'P',
      'CT',
      'Branch',
    ]) {
      expect(redact({ [key]: 'value' }), key).toEqual({ [key]: REDACTED });
    }
  });

  it('redacts compound credential and work-content names', () => {
    for (const key of [
      'id_token',
      'csrfToken',
      'x-api-key',
      'proxy-authorization',
      'authorization_code',
      'oauth_code',
      'client_secret',
      'secret_key',
      'webhookSecret',
      'password_hash',
      'newPassword',
      'private_key',
      'stripe-signature',
      'credentials',
      'cookies',
      'ws_ticket',
      'ticket',
      'sec-websocket-protocol',
      'file_path',
      'repoPaths',
      'git_branch',
      'branches',
    ]) {
      expect(redact({ [key]: 'value' }), key).toEqual({ [key]: REDACTED });
    }
  });

  it('keeps look-alike names that are not secrets', () => {
    const fields = {
      tokens_in: 120,
      tokens_out: 80,
      max_tokens: 4096,
      token_type: 'Bearer',
      api_key_id: KEY_ID,
      status_code: 503,
      error_code: 'quota_exceeded',
      context: 'startup',
      route: '/v1/sessions/:id',
      request_id: 'req_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      description: 'ok',
      pathname: '/healthz',
    };
    expect(redact(fields)).toEqual(fields);
  });

  it('leaves an undefined value under a denied key undefined (nothing to hide)', () => {
    const out = redact({ token: undefined, password: null }) as Record<string, unknown>;
    expect(out).toHaveProperty('token', undefined);
    expect(out['password']).toBe(REDACTED);
    expect(JSON.stringify(out)).toBe(`{"password":"${REDACTED}"}`);
  });
});

describe('value patterns', () => {
  it('acceptance 3: a cen_live_ key with 32 base62 characters is replaced wherever it appears', () => {
    expect(LIVE_KEY).toMatch(/^cen_live_[0-9A-Za-z]{32}$/);
    expect(redact(LIVE_KEY)).toBe(REDACTED);
    expect(redact({ note: LIVE_KEY })).toEqual({ note: REDACTED });
    expect(redact({ note: `using ${LIVE_KEY} for ci` })).toEqual({
      note: `using ${REDACTED} for ci`,
    });
    expect(redact({ a: [{ b: [`x=${LIVE_KEY}`] }] })).toEqual({ a: [{ b: [`x=${REDACTED}`] }] });
    expect(redact({ list: [LIVE_KEY, TEST_KEY] })).toEqual({ list: [REDACTED, REDACTED] });
  });

  it('acceptance 3: a three-part base64url JWT is replaced wherever it appears', () => {
    expect(JWT.split('.')).toHaveLength(3);
    expect(redact(JWT)).toBe(REDACTED);
    expect(redact({ ticket_json: JWT })).toEqual({ ticket_json: REDACTED });
    expect(redact({ header: `Authorization: Bearer ${JWT}` })).toEqual({
      header: `Authorization: Bearer ${REDACTED}`,
    });
    expect(redact({ note: `jwt=${JWT}; next` })).toEqual({ note: `jwt=${REDACTED}; next` });
    expect(redact([[`(${JWT})`]])).toEqual([[`(${REDACTED})`]]);
  });

  it('replaces a whole five-part JWE, ciphertext included', () => {
    expect(redact(`token ${JWE} end`)).toBe(`token ${REDACTED} end`);
  });

  it('replaces a token glued to the text around it, together with that text', () => {
    expect(redact(`abc_${JWT}`)).toBe(REDACTED);
    expect(redact(`x.${JWT}.y z`)).toBe(`${REDACTED} z`);
    expect(redact(`id${LIVE_KEY}`)).toBe(`id${REDACTED}`);
  });

  it('scans hostile strings in linear time', () => {
    const hostile = [
      'eyJ'.repeat(666),
      `${'eyJ.'.repeat(400)}x`,
      `${'bearer '.repeat(285)}!`,
      'cen_live_'.repeat(222),
      `${'a'.repeat(1990)}eyJ`,
    ];
    const input = Array.from({ length: 200 }, (_, i) => hostile[i % hostile.length]);
    redact(input);
    const started = performance.now();
    redact(input);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('replaces Bearer credentials in any case and keeps the scheme word', () => {
    expect(redact('sent Bearer abc.def-ghi_jkl~+/== upstream')).toBe(
      `sent Bearer ${REDACTED} upstream`,
    );
    expect(redact('authorization: bearer 0123456789')).toBe(`authorization: bearer ${REDACTED}`);
    expect(redact('BEARER x')).toBe(`BEARER ${REDACTED}`);
  });

  it('keeps dotted strings that are not tokens', () => {
    for (const s of ['api.centcom.dev', 'v1.2.3', 'eyJ.only-two', 'a.b.c', 'eyJabc.def']) {
      expect(redact(s)).toBe(s);
    }
  });

  it('redacts secrets inside keys too', () => {
    expect(redact({ [LIVE_KEY]: 1 })).toEqual({ [REDACTED]: 1 });
  });
});

describe('string cap', () => {
  it(`cuts strings longer than ${MAX_LOG_STRING_LENGTH} characters and marks the cut with …`, () => {
    const out = redact('a b '.repeat(2000)) as string;
    expect(out).toHaveLength(MAX_LOG_STRING_LENGTH);
    expect(out.endsWith('…')).toBe(true);
    const exact = 'x'.repeat(MAX_LOG_STRING_LENGTH);
    expect(redact(exact)).toBe(exact);
  });

  it('caps keys as well as values', () => {
    const out = redact({ ['k '.repeat(3000)]: 1 }) as Record<string, unknown>;
    const [key] = Object.keys(out);
    expect(key?.length).toBeLessThanOrEqual(MAX_LOG_STRING_LENGTH);
  });

  it('never keeps the start of a secret that crosses the cut', () => {
    const pad = 'a '.repeat(995); // 1990 characters, then the secret starts
    for (const secret of [LIVE_KEY, JWT, `Bearer ${base62(40)}`]) {
      const out = redact(pad + secret + ' tail'.repeat(10)) as string;
      expect(out.length).toBeLessThanOrEqual(MAX_LOG_STRING_LENGTH);
      expect(out.endsWith('…')).toBe(true);
      expect(out).not.toContain('cen_');
      expect(out).not.toContain('eyJ');
      expect(out).not.toContain(base62(8));
    }
  });

  it('still redacts a secret that ends before the cut', () => {
    const out = redact(`${'a '.repeat(500)}${LIVE_KEY}${' b'.repeat(2000)}`) as string;
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('cen_');
  });

  it('stays within the cap when a replacement is longer than the text it replaced', () => {
    const out = redact('Bearer x '.repeat(400)) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_LOG_STRING_LENGTH);
    expect(out).not.toMatch(/Bearer x/);
  });

  it('never splits a surrogate pair', () => {
    const out = redact(`${'a'.repeat(MAX_LOG_STRING_LENGTH - 2)}😀😀😀`) as string;
    const last = out.charCodeAt(out.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('structure', () => {
  it('replaces a cycle with [unserialisable] and keeps the rest', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    a['list'] = [a, 1];
    expect(redact(a)).toEqual({ name: 'a', self: UNSERIALISABLE, list: [UNSERIALISABLE, 1] });
  });

  it('copies a shared (not cyclic) object each time it appears', () => {
    const shared = { n: 1 };
    expect(redact({ x: shared, y: shared, z: [shared] })).toEqual({
      x: { n: 1 },
      y: { n: 1 },
      z: [{ n: 1 }],
    });
  });

  it(`copies the value and ${MAX_LOG_DEPTH} levels below it; deeper objects become [truncated]`, () => {
    const kept = redact(nest(MAX_LOG_DEPTH + 1));
    expect(descend(kept, MAX_LOG_DEPTH + 1)).toBe('leaf');
    const cut = redact(nest(MAX_LOG_DEPTH + 2));
    expect(descend(cut, MAX_LOG_DEPTH + 1)).toBe(TRUNCATED);
    const arrays = redact([[[[[[[[[[['deep']]]]]]]]]]]);
    expect(JSON.stringify(arrays)).toContain(TRUNCATED);
  });

  it(`stops after ${MAX_LOG_ENTRIES} entries, even for a huge sparse array`, () => {
    expect(redact(Array.from({ length: MAX_LOG_ENTRIES + 1 }, (_, i) => i))).toBe(TRUNCATED);
    const started = performance.now();
    expect(redact({ sparse: new Array(2 ** 32 - 1) })).toEqual({ sparse: TRUNCATED });
    expect(performance.now() - started).toBeLessThan(1000);
    const fits = Array.from({ length: 1000 }, (_, i) => i);
    expect(redact(fits)).toEqual(fits);
  });

  it('maps JSON-incompatible values the way JSON.stringify would, or safer', () => {
    const out = redact({
      big: 2n ** 70n,
      sym: Symbol('s'),
      fn: () => 1,
      when: new Date(Date.UTC(2026, 9, 6, 12, 0, 0, 5)),
      never: new Date(Number.NaN),
      inf: Number.POSITIVE_INFINITY,
      map: new Map([['token', 'x']]),
      hole: [1, , 3], // eslint-disable-line no-sparse-arrays
    });
    expect(out).toEqual({
      big: '1180591620717411303424',
      sym: undefined,
      fn: undefined,
      when: '2026-10-06T12:00:00.005Z',
      never: null,
      inf: Number.POSITIVE_INFINITY,
      map: {},
      hole: [1, undefined, 3],
    });
  });

  it('redacts Secrets and binary data', () => {
    expect(
      redact({
        db: new Secret('value'),
        raw: Buffer.from('key material'),
        view: new Uint8Array([1, 2]),
        buffer: new ArrayBuffer(4),
        shared: new SharedArrayBuffer(4),
      }),
    ).toEqual({ db: REDACTED, raw: REDACTED, view: REDACTED, buffer: REDACTED, shared: REDACTED });
  });

  it('keeps only the origin and path of web URLs', () => {
    expect(redact(new URL('https://user:pw@api.centcom.dev/v1/x?token=abc#frag'))).toBe(
      'https://api.centcom.dev/v1/x',
    );
    expect(redact(new URL('wss://relay.centcom.dev/ws?ticket=abc'))).toBe(
      'wss://relay.centcom.dev/ws',
    );
    expect(redact(new URL('file:///home/someone/repo/.env'))).toBe(REDACTED);
  });

  it('unboxes boxed primitives, so a boxed secret still meets the patterns', () => {
    expect(redact([new String(LIVE_KEY), new Number(2), new Boolean(false)])).toEqual([
      REDACTED,
      2,
      false,
    ]);
  });

  it('follows toJSON once per level, and ends chains of toJSON objects at the depth cap', () => {
    expect(redact({ v: { toJSON: () => ({ token: 'x', ok: 1 }) } })).toEqual({
      v: { token: REDACTED, ok: 1 },
    });
    const selfish = {
      a: 1,
      toJSON(): unknown {
        return this;
      },
    };
    expect(redact(selfish)).toEqual({ a: 1, toJSON: undefined });
    const endless = (): unknown => ({ toJSON: endless });
    expect(JSON.stringify(redact(endless()))).toBe(JSON.stringify(TRUNCATED));
  });

  it('turns objects that throw when read into [unserialisable], keeping their siblings', () => {
    const getter = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const trap = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    const badJson = {
      toJSON: () => {
        throw new Error('json');
      },
    };
    expect(redact({ getter, proxy, trap, badJson, ok: 1 })).toEqual({
      getter: UNSERIALISABLE,
      proxy: UNSERIALISABLE,
      trap: UNSERIALISABLE,
      badJson: UNSERIALISABLE,
      ok: 1,
    });
  });

  it('copies a __proto__ key as data, without touching any prototype', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as object;
    const out = redact(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'ok']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('errors', () => {
  it('keeps type, message, stack and code; redacts secrets and paths', () => {
    const err = Object.assign(new Error(`login failed for ${LIVE_KEY}`), {
      code: 'ECONNREFUSED',
      path: '/home/someone/repo',
      status: 502,
    });
    const out = redact({ err }) as { err: Record<string, unknown> };
    expect(out.err).toMatchObject({
      type: 'Error',
      message: `login failed for ${REDACTED}`,
      code: 'ECONNREFUSED',
      path: REDACTED,
      status: 502,
    });
    expect(out.err['stack']).toEqual(expect.stringContaining('login failed for [redacted]'));
    expect(JSON.stringify(out)).not.toContain('cen_live');
  });

  it('keeps the cause chain and the errors of an AggregateError', () => {
    const inner = new TypeError('inner');
    const outer = new Error('outer', { cause: inner });
    const all = new AggregateError([outer, 'plain'], 'many');
    const out = redact(all) as Record<string, unknown>;
    expect(out).toMatchObject({
      type: 'AggregateError',
      message: 'many',
      errors: [
        { type: 'Error', message: 'outer', cause: { type: 'TypeError', message: 'inner' } },
        'plain',
      ],
    });
  });
});

describe('purity and speed', () => {
  it('never mutates its input (frozen input, deep equality before and after)', () => {
    const input = deepFreeze({
      authorization: 'Bearer abc',
      nested: { refresh_token: 'x', list: [LIVE_KEY, { p: 'frame' }] },
      long: 'z '.repeat(3000),
    });
    const before = structuredClone(input);
    redact(input);
    expect(input).toEqual(before);
  });

  it('acceptance 7: copies a 1 MB object exactly (secrets aside) without mutating it', () => {
    const input = megabyteObject();
    expect(JSON.stringify(input).length).toBeGreaterThan(1_000_000);
    const before = structuredClone(input);
    const out = redact(input);
    expect(input).toEqual(before);
    expect(out).toEqual({ ...before, token: REDACTED });
  });

  it('acceptance 7: redacts a 1 MB object in under 50 ms', () => {
    // Timed in a separate process: this worker runs under coverage instrumentation (several
    // times slower) and shares the CPU with other test files. Best of 10 runs after a warm-up.
    const out = execFileSync(process.execPath, ['--import', 'tsx', BENCH], {
      cwd: CORE_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const { bytes, bestMs } = JSON.parse(out) as { bytes: number; bestMs: number };
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(bestMs).toBeLessThan(50);
  }, 60_000);
});
