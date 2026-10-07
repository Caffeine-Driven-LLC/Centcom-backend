/**
 * Paging parameters (B025, card test query.test.ts; acceptance 2): the default limit, limits out
 * of range or not numbers, the clamp to 200, the sort allow-list, refused offsets, and cursors
 * that cannot be cursors.
 */
import { describe, expect, it } from 'vitest';
import { AppError, DEFAULT_LIMIT, MAX_LIMIT, parsePageQuery } from '../../src/index.js';

const SPEC = { sorts: ['created_at', '-created_at'], defaultSort: '-created_at' } as const;

/** The AppError `fn` throws. */
function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected an AppError');
}

describe('parsePageQuery', () => {
  it('defaults to 50 items in the default sort, for an empty or missing query', () => {
    for (const q of [{}, undefined, null, 'limit=5', 42]) {
      expect(parsePageQuery(q, SPEC)).toEqual({ limit: DEFAULT_LIMIT, sort: '-created_at' });
    }
    expect(DEFAULT_LIMIT).toBe(50);
  });

  it('takes a limit from 1 to 200, a listed sort and a cursor', () => {
    expect(parsePageQuery({ limit: '1', sort: 'created_at', cursor: 'k1.abc.def' }, SPEC)).toEqual({
      limit: 1,
      sort: 'created_at',
      cursor: 'k1.abc.def',
    });
    expect(parsePageQuery({ limit: '200' }, SPEC).limit).toBe(MAX_LIMIT);
  });

  it.each([
    ['0', 'out_of_range'],
    ['201', 'out_of_range'],
    ['abc', 'invalid_type'],
    ['-1', 'invalid_type'],
    ['1.5', 'invalid_type'],
    ['', 'invalid_type'],
    ['1e2', 'invalid_type'],
    ['9999999', 'invalid_type'],
  ])('refuses limit=%j with a problem pointing at /limit (acceptance 2)', (limit, code) => {
    const error = thrown(() => parsePageQuery({ limit }, SPEC));
    expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
    expect(error.errors).toEqual([expect.objectContaining({ pointer: '/limit', code })]);
  });

  it('refuses a repeated limit', () => {
    expect(thrown(() => parsePageQuery({ limit: ['1', '2'] }, SPEC)).errors?.[0]).toMatchObject({
      pointer: '/limit',
    });
  });

  it('clamps an endpoint maximum to 200, and honours a smaller one', () => {
    const generous = { ...SPEC, maxLimit: 500 };
    expect(thrown(() => parsePageQuery({ limit: '201' }, generous)).errors?.[0]?.code).toBe(
      'out_of_range',
    );
    const small = { ...SPEC, maxLimit: 20 };
    expect(parsePageQuery({}, small).limit).toBe(20);
    expect(thrown(() => parsePageQuery({ limit: '21' }, small)).errors?.[0]?.detail).toBe(
      'must be 1 to 20',
    );
  });

  it('refuses a sort outside the allow-list, listing the allowed ones', () => {
    for (const sort of ['name', ['created_at', 'created_at'], 'CREATED_AT']) {
      const error = thrown(() => parsePageQuery({ sort }, SPEC));
      expect(error.errors).toEqual([
        {
          pointer: '/sort',
          code: 'invalid_value',
          detail: 'must be one of: created_at, -created_at',
        },
      ]);
    }
  });

  it('refuses offsets, page numbers and skip, every problem at once', () => {
    const error = thrown(() =>
      parsePageQuery({ limit: '0', offset: '10', page: '2', skip: '5', sort: 'name' }, SPEC),
    );
    expect(error.errors?.map((e) => [e.pointer, e.code])).toEqual([
      ['/limit', 'out_of_range'],
      ['/sort', 'invalid_value'],
      ['/offset', 'not_supported'],
      ['/page', 'not_supported'],
      ['/skip', 'not_supported'],
    ]);
  });

  it.each([
    ['empty', ''],
    ['repeated', ['a.b.c', 'a.b.c']],
    ['too long', `a.${'b'.repeat(1100)}.c`],
    ['not URL-safe', 'a.b/c.d'],
  ])('answers a cursor that is %s with 400 cursor_invalid on /cursor', (_name, cursor) => {
    const error = thrown(() => parsePageQuery({ cursor }, SPEC));
    expect(error).toMatchObject({ code: 'cursor_invalid', status: 400 });
    expect(error.errors).toEqual([{ pointer: '/cursor', code: 'invalid' }]);
  });

  it('refuses a spec whose default sort it does not list', () => {
    expect(() => parsePageQuery({}, { sorts: ['a'], defaultSort: 'b' })).toThrow(TypeError);
  });
});
