/**
 * Filters (B025, card test filters.test.ts): each filter type, undeclared parameters ignored,
 * every bad parameter reported with its pointer, and a hash that is stable for the same filters
 * and different for different ones.
 */
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  booleanFilter,
  defineFilters,
  enumFilter,
  idFilter,
  rangeFilter,
  stringFilter,
} from '../../src/index.js';

const SESSIONS = defineFilters({
  workspace: idFilter('wsp'),
  state: enumFilter(['active', 'paused', 'ended', 'expired']),
  mine: booleanFilter(),
  action: stringFilter({ maxLength: 20 }),
  created: rangeFilter(),
  window: rangeFilter({ from: 'from', to: 'to' }),
});

/** The field errors of the 422 `fn` throws. */
function problems(fn: () => unknown): [string, string][] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: 'validation_failed', status: 422 });
    return ((e as AppError).errors ?? []).map((f) => [f.pointer, f.code]);
  }
  throw new Error('expected a validation problem');
}

describe('defineFilters', () => {
  it('reads every declared filter and ignores everything else', () => {
    const workspace = newId('wsp');
    const filters = SESSIONS.parse({
      workspace,
      state: 'active',
      mine: 'true',
      action: 'session.create',
      created_from: '2026-10-01T00:00:00Z',
      created_to: '2026-10-07T00:00:00.5+02:00',
      from: '2026-09-01T00:00:00Z',
      limit: '50',
      cursor: 'k1.a.b',
      unknown: 'ignored',
    });
    expect(filters).toEqual({
      workspace,
      state: 'active',
      mine: true,
      action: 'session.create',
      created: {
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-10-06T22:00:00.500Z'),
      },
      window: { from: new Date('2026-09-01T00:00:00Z') },
    });
    expect(SESSIONS.parse({})).toEqual({});
    expect(SESSIONS.parse(undefined)).toEqual({});
    expect(SESSIONS.parse({ mine: 'false', to: '2026-01-01T00:00:00Z' })).toEqual({
      mine: false,
      window: { to: new Date('2026-01-01T00:00:00Z') },
    });
  });

  it('reports every bad parameter with its pointer', () => {
    expect(
      problems(() =>
        SESSIONS.parse({
          workspace: newId('usr'),
          state: 'deleted',
          mine: 'yes',
          action: 'x'.repeat(21),
          created_from: 'yesterday',
          from: '2026-10-07T00:00:00Z',
          to: '2026-10-07T00:00:00Z',
        }),
      ),
    ).toEqual([
      ['/workspace', 'invalid_format'],
      ['/state', 'invalid_value'],
      ['/mine', 'invalid_type'],
      ['/action', 'invalid_format'],
      ['/created_from', 'invalid_format'],
      ['/to', 'out_of_range'],
    ]);
  });

  it('refuses repeated parameters, empty text and control characters', () => {
    expect(problems(() => SESSIONS.parse({ state: ['active', 'paused'] }))).toEqual([
      ['/state', 'invalid_type'],
    ]);
    expect(problems(() => SESSIONS.parse({ action: '' }))).toEqual([['/action', 'invalid_format']]);
    expect(problems(() => SESSIONS.parse({ action: 'a\u0000b' }))).toEqual([
      ['/action', 'invalid_format'],
    ]);
    expect(problems(() => SESSIONS.parse({ created_to: '2026-10-07' }))).toEqual([
      ['/created_to', 'invalid_format'],
    ]);
  });

  it('hashes the same filters alike, however they were spelled or ordered', () => {
    const workspace = newId('wsp');
    const a = SESSIONS.parse({ state: 'active', workspace, created_from: '2026-10-01T00:00:00Z' });
    const b = SESSIONS.parse({
      created_from: '2026-10-01T02:00:00.000+02:00',
      workspace,
      state: 'active',
      unknown: 'x',
    });
    expect(SESSIONS.hash(a)).toBe(SESSIONS.hash(b));
    expect(SESSIONS.hash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SESSIONS.hash({})).toBe(SESSIONS.hash(SESSIONS.parse({ limit: '10' })));
  });

  it('hashes filters built in any key order alike, not just parsed ones', () => {
    const [from, to] = [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z')];
    expect(SESSIONS.hash({ state: 'active', mine: true, created: { from, to } })).toBe(
      SESSIONS.hash({ created: { to, from }, mine: true, state: 'active' }),
    );
  });

  it('hashes different filters differently (property)', () => {
    const states = fc.constantFrom('active', 'paused', 'ended', 'expired');
    fc.assert(
      fc.property(fc.option(states), fc.option(states), fc.boolean(), (one, two, mine) => {
        fc.pre(one !== two);
        const query = (state: string | null): Record<string, string> => ({
          ...(state === null ? {} : { state }),
          mine: String(mine),
        });
        expect(SESSIONS.hash(SESSIONS.parse(query(one)))).not.toBe(
          SESSIONS.hash(SESSIONS.parse(query(two))),
        );
      }),
    );
  });
});
