/**
 * Feature flag evaluation (B083 test plan "unit" and "property"): the bucket function's golden
 * vectors, a 30 % rollout over 100 000 ids, rule precedence (kill switch, plan, workspace, version,
 * percent), what anonymous callers and clients see, client versions from User-Agent, definition
 * checks, and evaluation that is deterministic and independent of definition order.
 */
import { newId } from '@centcom/contracts';
import { isAppError } from '@centcom/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bucketOf, BUCKETS, inRollout } from '../../src/modules/flags/bucket.js';
import { loadFlagsConfig } from '../../src/modules/flags/config.js';
import {
  checkFlagDef,
  readStoredFlag,
  type EvalFlag,
  type FlagRow,
} from '../../src/modules/flags/definition.js';
import { evaluateFlags, isEnabledIn, type EvalContext } from '../../src/modules/flags/evaluate.js';
import { compareSemver, parseClientVersion, parseSemver } from '../../src/modules/flags/version.js';

const NOW = new Date('2026-11-01T09:00:00Z');
const LIMITS = { maxValueBytes: 2048 };

/** A stored flag ready to evaluate. */
function flag(key: string, over: Partial<FlagRow> = {}): EvalFlag {
  return readStoredFlag({
    key,
    type: 'bool',
    value: true,
    default_value: false,
    public: false,
    server_only: false,
    kill: false,
    rules: [],
    ...over,
  });
}

/** The pointers of the 422 `fn` throws. */
function pointers(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (isAppError(err)) return (err.errors ?? []).map((e) => e.pointer);
    throw err;
  }
  throw new Error('expected a 422');
}

describe('buckets', () => {
  it('matches the golden vectors', () => {
    // [flag, user, bucket]: SHA-256 of `flag:user`, first 32 bits, modulo 10 000.
    const vectors: [string, string, number][] = [
      ['new_checkout', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 6309],
      ['new_checkout', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X', 6618],
      ['new_checkout', 'usr_01HZZZZZZZZZZZZZZZZZZZZZZZ', 9419],
      ['new_checkout', 'usr_00000000000000000000000000', 8927],
      ['new_checkout.v2', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 7187],
      ['new_checkout.v2', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X', 458],
      ['relay.compression', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 1514],
      ['relay.compression', 'usr_00000000000000000000000000', 3742],
    ];
    for (const [name, user, bucket] of vectors) expect(bucketOf(name, user), name).toBe(bucket);
    expect(inRollout('new_checkout.v2', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X', 459)).toBe(true);
    expect(inRollout('new_checkout.v2', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X', 458)).toBe(false);
  });

  it('lets in 29 % to 31 % of 100 000 users at 30 %, the same ones every time', () => {
    const users = Array.from({ length: 100_000 }, () => newId('usr'));
    const on = (name: string) => users.filter((u) => inRollout(name, u, 3000));
    const first = on('new_checkout');
    expect(first.length / users.length).toBeGreaterThanOrEqual(0.29);
    expect(first.length / users.length).toBeLessThanOrEqual(0.31);
    expect(on('new_checkout')).toEqual(first);
    // Another flag key assigns users independently: about 30 % of the first set again.
    const other = new Set(on('new_checkout.v2'));
    const overlap = first.filter((u) => other.has(u)).length / first.length;
    expect(overlap).toBeGreaterThan(0.27);
    expect(overlap).toBeLessThan(0.33);
    // Raising the percentage only adds users.
    const forty = new Set(users.filter((u) => inRollout('new_checkout', u, 4000)));
    expect(first.every((u) => forty.has(u))).toBe(true);
    expect(Math.max(...users.slice(0, 1000).map((u) => bucketOf('x', u)))).toBeLessThan(BUCKETS);
  });
});

describe('rule precedence', () => {
  const user = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
  const ws = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
  const ctx: EvalContext = {
    userId: user,
    workspaceId: ws,
    plan: 'pro',
    clientVersion: '1.4.2',
    now: NOW,
  };
  const all = [
    { type: 'plans', plans: ['pro'] },
    { type: 'workspaces', workspaces: [ws] },
    { type: 'client_version', min: '1.2.0' },
    { type: 'percent', percent: 100 },
  ];

  it('serves the value only when every rule passes', () => {
    expect(evaluateFlags(ctx, [flag('f', { rules: all })])).toEqual({ f: true });
  });

  it('lets a kill switch override every rule, for everyone who sees the flag', () => {
    const killed = flag('f', { rules: all, kill: true });
    expect(evaluateFlags(ctx, [killed])).toEqual({ f: false });
    // Even a client too old for its version rule sees the default rather than nothing.
    expect(evaluateFlags({ ...ctx, clientVersion: '1.0.0' }, [killed])).toEqual({ f: false });
    expect(isEnabledIn(new Map([['f', killed]]), 'f', ctx)).toBe(false);
  });

  it('then checks the plan, the workspace, the version and the percentage', () => {
    const f = [flag('f', { rules: all })];
    expect(evaluateFlags({ ...ctx, plan: 'free' }, f)).toEqual({ f: false });
    expect(evaluateFlags({ ...ctx, plan: undefined }, f)).toEqual({ f: false });
    expect(evaluateFlags({ ...ctx, workspaceId: 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4X' }, f)).toEqual({
      f: false,
    });
    // A version out of range hides the flag (it is not merely off).
    expect(evaluateFlags({ ...ctx, clientVersion: '1.1.9' }, f)).toEqual({});
    const half = [flag('f', { rules: [...all.slice(0, 3), { type: 'percent', percent: 0 }] })];
    expect(evaluateFlags(ctx, half)).toEqual({ f: false });
  });

  it('serves the default for a stored rule it does not know', () => {
    const broken = flag('f', { rules: [{ type: 'moon_phase', phase: 'full' }] });
    expect(broken.broken).toBe(true);
    expect(evaluateFlags(ctx, [broken])).toEqual({ f: false });
    expect(flag('g', { rules: 'not a list' }).broken).toBe(true);
    expect(flag('h', { rules: [{ type: 'percent', percent: 300 }] }).broken).toBe(true);
  });
});

describe('what clients see', () => {
  const user = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
  const anonymous: EvalContext = { now: NOW };

  it('shows anonymous callers only public flags without per-user rules', () => {
    const defs = [
      flag('public.plain', { public: true }),
      flag('public.rollout', { public: true, rules: [{ type: 'percent', percent: 100 }] }),
      flag('public.plan', { public: true, rules: [{ type: 'plans', plans: ['free'] }] }),
      flag('public.versioned', { public: true, rules: [{ type: 'client_version', min: '1.0.0' }] }),
      flag('private.plain'),
    ];
    expect(evaluateFlags(anonymous, defs)).toEqual({ 'public.plain': true });
    expect(evaluateFlags({ ...anonymous, clientVersion: '1.0.0' }, defs)).toEqual({
      'public.plain': true,
      'public.versioned': true,
    });
    expect(
      evaluateFlags({ now: NOW, userId: user, plan: 'free', clientVersion: '1.0.0' }, defs),
    ).toEqual({
      'private.plain': true,
      'public.plain': true,
      'public.plan': true,
      'public.rollout': true,
      'public.versioned': true,
    });
  });

  it('never sends a server_only flag, and returns keys and values only', () => {
    const defs = [
      flag('ops.only', { server_only: true }),
      flag('rollout', {
        rules: [
          { type: 'percent', percent: 50 },
          { type: 'workspaces', workspaces: ['wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W'] },
        ],
      }),
      flag('config', { type: 'json', value: { limit: 5 }, default_value: { limit: 1 } }),
    ];
    const out = evaluateFlags({ now: NOW, userId: user }, defs);
    expect(Object.keys(out)).toEqual(['config', 'rollout']);
    expect(out['config']).toEqual({ limit: 5 });
    expect(JSON.stringify(out)).not.toMatch(/percent|workspaces|wsp_|plans|rules/);
    expect(isEnabledIn(new Map(defs.map((d) => [d.key, d])), 'ops.only', { now: NOW })).toBe(true);
    expect(isEnabledIn(new Map(), 'missing', { now: NOW })).toBe(false);
  });

  it('applies min and max client versions, and hides versioned flags from unknown clients', () => {
    const defs = [
      flag('min', { rules: [{ type: 'client_version', min: '1.2.0' }] }),
      flag('max', { rules: [{ type: 'client_version', max: '2.0.0' }] }),
      flag('plain'),
    ];
    const seen = (clientVersion?: string) =>
      Object.keys(
        evaluateFlags(
          { now: NOW, userId: user, ...(clientVersion === undefined ? {} : { clientVersion }) },
          defs,
        ),
      );
    expect(seen('1.1.9')).toEqual(['max', 'plain']);
    expect(seen('1.2.0')).toEqual(['max', 'min', 'plain']);
    expect(seen('1.2.0-rc.1')).toEqual(['max', 'plain']);
    expect(seen('2.0.0')).toEqual(['max', 'min', 'plain']);
    expect(seen('2.0.1')).toEqual(['min', 'plain']);
    expect(seen()).toEqual(['plain']);
  });
});

describe('client versions', () => {
  it('reads Centcom User-Agents (CT-VER) and nothing else', () => {
    const cases: [unknown, string | null][] = [
      ['centcom-cli/1.4.2 (contract/1.0.0; linux-x64; node/22.9.0)', '1.4.2'],
      ['centcom-cli/1.2.0', '1.2.0'],
      ['centcom-desktop/2.0.0-beta.3 (contract/1.1.0)', '2.0.0-beta.3'],
      ['centcom-cli/1.1.9+build.7 (x)', '1.1.9'],
      ['Mozilla/5.0 (X11; Linux x86_64)', null],
      ['centcom-cli/one.two', null],
      ['centcom-cli/1.2', null],
      ['centcom-cli/01.2.3', null],
      [' centcom-cli/1.2.3', null],
      [`centcom-cli/1.2.3 ${'x'.repeat(600)}`, null],
      [undefined, null],
      [['centcom-cli/1.2.3'], null],
    ];
    for (const [header, version] of cases) {
      const parsed = parseClientVersion(header);
      const text =
        parsed === null
          ? null
          : `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.pre.length > 0 ? `-${parsed.pre.join('.')}` : ''}`;
      expect(text, JSON.stringify(header)).toBe(version);
    }
  });

  it('orders versions as SemVer 2.0 does', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.2.0',
      '1.10.0',
      '2.0.0',
    ];
    const parsed = ordered.map((v) => parseSemver(v));
    for (let i = 0; i + 1 < parsed.length; i += 1) {
      const a = parsed[i];
      const b = parsed[i + 1];
      if (a === null || b === null || a === undefined || b === undefined) throw new Error('parse');
      expect(compareSemver(a, b), `${ordered[i]} < ${ordered[i + 1]}`).toBe(-1);
      expect(compareSemver(b, a)).toBe(1);
      expect(compareSemver(a, a)).toBe(0);
    }
  });
});

describe('definitions', () => {
  it('accepts a complete definition and fills the defaults', () => {
    expect(
      checkFlagDef(
        {
          key: 'relay.compression',
          type: 'string',
          value: 'zstd',
          default: 'none',
          rules: [{ type: 'percent', percent: 12.5 }],
        },
        LIMITS,
      ),
    ).toEqual({
      key: 'relay.compression',
      type: 'string',
      value: 'zstd',
      default: 'none',
      public: false,
      server_only: false,
      kill: false,
      rules: [{ type: 'percent', percent: 12.5 }],
    });
  });

  it('refuses keys that name secrets, bad types, and oversized or secret-like values', () => {
    const base = { key: 'ok', type: 'bool', value: true, default: false };
    for (const key of [
      'api.key',
      'stripe_secret',
      'github-token',
      'db.password',
      'UPPER',
      'a'.repeat(65),
      '',
      '__proto__',
    ]) {
      expect(
        pointers(() => checkFlagDef({ ...base, key }, LIMITS)),
        key,
      ).toEqual(['/key']);
    }
    // Words that merely contain a denied one are fine.
    expect(checkFlagDef({ ...base, key: 'keyboard.shortcuts' }, LIMITS).key).toBe(
      'keyboard.shortcuts',
    );
    expect(pointers(() => checkFlagDef({ ...base, value: 'yes' }, LIMITS))).toEqual(['/value']);
    expect(
      pointers(() => checkFlagDef({ ...base, type: 'json', value: [1], default: {} }, LIMITS)),
    ).toEqual(['/value']);
    expect(
      pointers(() =>
        checkFlagDef({ ...base, type: 'number', value: Number.NaN, default: 1 }, LIMITS),
      ),
    ).toEqual(['/value']);
    // 2 048 bytes of JSON is the most.
    const at = 'x'.repeat(2046);
    expect(checkFlagDef({ ...base, type: 'string', value: at, default: '' }, LIMITS).value).toBe(
      at,
    );
    expect(
      pointers(() =>
        checkFlagDef({ ...base, type: 'string', value: `${at}x`, default: '' }, LIMITS),
      ),
    ).toEqual(['/value']);
    for (const value of ['ops@example.test', '10.0.0.1', `eyJhbGciOiJIUzI1NiJ9.${'e30'}`]) {
      expect(
        pointers(() => checkFlagDef({ ...base, type: 'string', value, default: '' }, LIMITS)),
        value,
      ).toEqual(['/value']);
    }
    expect(
      pointers(() =>
        checkFlagDef(
          { ...base, type: 'json', value: { contact: 'a@b.test' }, default: {} },
          LIMITS,
        ),
      ),
    ).toEqual(['/value']);
    expect(
      pointers(() => checkFlagDef({ ...base, public: true, server_only: true }, LIMITS)),
    ).toEqual(['/public']);
  });

  it('refuses unknown or malformed rules, and a rule given twice', () => {
    const base = { key: 'ok', type: 'bool', value: true, default: false };
    const bad: [unknown, string][] = [
      [{ type: 'percent', percent: 101 }, '/rules/0/percent'],
      [{ type: 'percent', percent: 0.001 }, '/rules/0/percent'],
      [{ type: 'plans', plans: ['enterprise'] }, '/rules/0/plans'],
      [{ type: 'plans', plans: [] }, '/rules/0/plans'],
      [
        { type: 'workspaces', workspaces: ['usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W'] },
        '/rules/0/workspaces',
      ],
      [{ type: 'client_version' }, '/rules/0/min'],
      [{ type: 'client_version', min: '1.2' }, '/rules/0/min'],
      [{ type: 'moon_phase' }, '/rules/0/type'],
      ['percent', '/rules/0'],
    ];
    for (const [rule, pointer] of bad) {
      expect(
        pointers(() => checkFlagDef({ ...base, rules: [rule] }, LIMITS)),
        JSON.stringify(rule),
      ).toEqual([pointer]);
    }
    expect(
      checkFlagDef({ ...base, rules: [{ type: 'percent', percent: 0.29 }] }, LIMITS).rules,
    ).toEqual([{ type: 'percent', percent: 0.29 }]);
    expect(
      pointers(() =>
        checkFlagDef(
          {
            ...base,
            rules: [
              { type: 'percent', percent: 1 },
              { type: 'percent', percent: 2 },
            ],
          },
          LIMITS,
        ),
      ),
    ).toEqual(['/rules/1/type']);
  });

  it('reads the configuration with the card defaults and bounds', () => {
    expect(loadFlagsConfig({})).toEqual({ ttlS: 60, maxCount: 500, maxValueBytes: 2048 });
    expect(() => loadFlagsConfig({ FLAGS_MAX_COUNT: '501' })).toThrow(/FLAGS_MAX_COUNT/);
    expect(() => loadFlagsConfig({ FLAGS_MAX_VALUE_BYTES: '4096' })).toThrow(
      /FLAGS_MAX_VALUE_BYTES/,
    );
  });
});

describe('properties', () => {
  const ruleArb = fc.oneof(
    fc.record({
      type: fc.constant('percent'),
      percent: fc.integer({ min: 0, max: 10_000 }).map((n) => n / 100),
    }),
    fc.record({
      type: fc.constant('plans'),
      plans: fc.subarray(['free', 'pro', 'team'], { minLength: 1 }),
    }),
    fc.record({
      type: fc.constant('client_version'),
      min: fc.constantFrom('1.0.0', '1.2.0', '2.0.0'),
    }),
  );
  const flagArb = fc.record({
    key: fc.stringMatching(/^[a-z0-9_.-]{1,12}$/),
    public: fc.boolean(),
    server_only: fc.boolean(),
    kill: fc.boolean(),
    rules: fc.uniqueArray(ruleArb, { selector: (r) => r.type, maxLength: 3 }),
  });
  const ctxArb = fc.record(
    {
      userId: fc.constantFrom('usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4X'),
      plan: fc.constantFrom('free' as const, 'pro' as const, 'team' as const),
      clientVersion: fc.constantFrom('1.1.0', '1.2.0', '2.0.0'),
    },
    { requiredKeys: [] },
  );

  it('evaluates deterministically, whatever the order of the definitions', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(flagArb, { selector: (f) => f.key, maxLength: 20 }),
        ctxArb,
        fc.integer(),
        (raw, partial, seed) => {
          const defs = raw.map((f) => flag(f.key, { ...f, public: f.public && !f.server_only }));
          const ctx: EvalContext = { ...partial, now: NOW };
          const once = evaluateFlags(ctx, defs);
          const shuffled = [...defs].sort(() =>
            (seed = (seed * 1103515245 + 12345) | 0) & 1 ? 1 : -1,
          );
          expect(evaluateFlags(ctx, shuffled)).toEqual(once);
          expect(JSON.stringify(evaluateFlags(ctx, shuffled))).toBe(JSON.stringify(once));
          expect(evaluateFlags(ctx, defs)).toEqual(once);
          // Never a server_only flag; anonymous callers never a per-user rule.
          for (const d of defs) {
            if (d.serverOnly) expect(Object.hasOwn(once, d.key), d.key).toBe(false);
          }
          if (ctx.userId === undefined) {
            for (const d of defs) {
              if (d.basisPoints !== null || d.plans !== null)
                expect(Object.hasOwn(once, d.key), d.key).toBe(false);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
