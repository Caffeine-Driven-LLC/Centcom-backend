/**
 * toProblem (B006): the problem shape for every registry code (table-driven, validated against
 * contracts/schemas/problem.schema.json), the CT-ERR fixtures reproduced exactly, retry hints only
 * where rule 6 asks for them, and unknown errors reduced to a generic 500 that never carries their
 * message, stack or properties (property-tested).
 */
import { validateProblem } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  DEFAULT_RETRY_AFTER_S,
  ERROR_CODES,
  ERROR_DETAILS,
  errorEntry,
  fallbackProblemBody,
  isErrorCode,
  MAX_FIELD_ERRORS,
  MAX_RETRY_AFTER_S,
  toProblem,
  validationFailed,
  type ErrorCode,
  type FieldError,
  type Problem,
} from '../../src/index.js';
import { CTX, JWT, LIVE_KEY, readContract, REQUEST_ID, type ProblemFixture } from './helpers.js';

const SEED = 20261007;
/** The property tests run a few thousand cases; well inside the lane's 60 s budget. */
const TIMEOUT = 60_000;

/** Fails with the schema's issues if `problem` is not a valid CT-ERR problem. */
function expectValid(problem: unknown): void {
  const result = validateProblem(problem);
  expect(result.ok ? [] : result.errors).toEqual([]);
}

/** True if CT-ERR rule 6 asks for retry_after_s on this code. */
const wantsRetry = (code: ErrorCode): boolean => {
  const { status, retryable } = errorEntry(code);
  return status === 429 || status === 503 || retryable;
};

describe('toProblem for every registry code (table-driven)', () => {
  it.each(ERROR_CODES.map((code) => [code]))('%s', (code) => {
    const entry = errorEntry(code);
    const problem = toProblem(new AppError(code), CTX);
    expectValid(problem);
    expect(problem).toEqual({
      type: `https://centcom.dev/errors/${code}`,
      title: entry.title,
      status: entry.status,
      code,
      request_id: REQUEST_ID,
      ...(wantsRetry(code) ? { retry_after_s: DEFAULT_RETRY_AFTER_S } : {}),
    });

    const full = toProblem(
      new AppError(code, {
        detail: 'Safe words.',
        retryAfterS: 30,
        errors: [{ pointer: '/a', code: 'required', detail: 'is required' }],
      }),
      { requestId: REQUEST_ID, instance: '/v1/things/:id' },
    );
    expectValid(full);
    expect(full).toMatchObject({ detail: 'Safe words.', instance: '/v1/things/:id' });
    expect(full.errors).toEqual([{ pointer: '/a', code: 'required', detail: 'is required' }]);
    if (wantsRetry(code)) expect(full.retry_after_s).toBe(30);
    else expect(full).not.toHaveProperty('retry_after_s');
  });

  it('covers both sides of rule 6', () => {
    expect(ERROR_CODES.filter(wantsRetry).length).toBeGreaterThan(5);
    expect(ERROR_CODES.filter((c) => !wantsRetry(c)).length).toBeGreaterThan(5);
  });
});

describe('contract fixtures (contracts/fixtures/problem)', () => {
  it('quota.json: a quota_exceeded AppError gives exactly the fixture body, key order included', () => {
    const fixture = readContract<ProblemFixture>('fixtures', 'problem', 'quota.json');
    expect(fixture.valid).toBe(true);
    const problem = toProblem(
      new AppError('quota_exceeded', { detail: 'Monthly agent-minutes used.', retryAfterS: 3600 }),
      CTX,
    );
    expect(JSON.stringify(problem)).toBe(JSON.stringify(fixture.data));
  });

  it('validation.json: validationFailed() gives exactly the fixture body, key order included', () => {
    const fixture = readContract<ProblemFixture>('fixtures', 'problem', 'validation.json');
    expect(fixture.valid).toBe(true);
    const errors = fixture.data['errors'] as FieldError[];
    const problem = toProblem(validationFailed(errors), CTX);
    expect(JSON.stringify(problem)).toBe(JSON.stringify(fixture.data));
  });

  it.each(['missing_code.json', 'status_200.json'])(
    '%s is rejected by the schema the shape tests use',
    (file) => {
      const fixture = readContract<ProblemFixture>('fixtures', 'problem', file);
      expect(fixture.valid).toBe(false);
      expect(validateProblem(fixture.data).ok).toBe(false);
    },
  );
});

describe('retry_after_s (CT-ERR rule 6)', () => {
  it('is present for 429 and 503 and for retryable codes of other statuses', () => {
    expect(toProblem(new AppError('rate_limited', { retryAfterS: 30 }), CTX).retry_after_s).toBe(
      30,
    );
    expect(toProblem(new AppError('service_unavailable'), CTX).retry_after_s).toBe(
      DEFAULT_RETRY_AFTER_S,
    );
    expect(toProblem(new AppError('session_paused', { retryAfterS: 5 }), CTX).retry_after_s).toBe(
      5,
    );
    expect(toProblem(new AppError('internal_error'), CTX).retry_after_s).toBe(
      DEFAULT_RETRY_AFTER_S,
    );
  });

  it('is never present for 400, 403 and 404 codes that are not retryable, even when given', () => {
    for (const code of [
      'invalid_request',
      'forbidden',
      'not_found',
      'role_insufficient',
      'gone',
    ] as const) {
      expect(toProblem(new AppError(code, { retryAfterS: 60 }), CTX), code).not.toHaveProperty(
        'retry_after_s',
      );
    }
  });

  it('is a whole number of seconds within [0, MAX_RETRY_AFTER_S]', () => {
    const hint = (retryAfterS: number): number | undefined =>
      toProblem(new AppError('rate_limited', { retryAfterS }), CTX).retry_after_s;
    expect(hint(0)).toBe(0);
    expect(hint(2.1)).toBe(3);
    expect(hint(0.001)).toBe(1);
    expect(hint(1e12)).toBe(MAX_RETRY_AFTER_S);
    for (const bad of [-1, Number.NaN, Infinity, -Infinity])
      expect(hint(bad), String(bad)).toBe(DEFAULT_RETRY_AFTER_S);
  });
});

describe('codes and statuses', () => {
  it('keeps an allowed status override with the generic code (405, 414)', () => {
    const problem = toProblem(new AppError('invalid_request', { status: 405 }), CTX);
    expectValid(problem);
    expect(problem).toMatchObject({
      code: 'invalid_request',
      status: 405,
      title: 'Invalid request',
    });
    expect(problem).not.toHaveProperty('retry_after_s');
  });

  it('sends a code missing from the registry as the generic code of its status class (rule 7)', () => {
    const teapot = toProblem(
      new AppError('teapot' as ErrorCode, { status: 418, detail: 'Short and stout.' }),
      CTX,
    );
    expectValid(teapot);
    expect(teapot).toMatchObject({
      code: 'invalid_request',
      status: 418,
      detail: 'Short and stout.',
    });
    const server = toProblem(new AppError('teapot' as ErrorCode), CTX);
    expect(server).toMatchObject({
      code: 'internal_error',
      status: 500,
      retry_after_s: DEFAULT_RETRY_AFTER_S,
    });
  });
});

describe('unknown errors', () => {
  const generic: Problem = {
    type: 'https://centcom.dev/errors/internal_error',
    title: 'Internal error',
    status: 500,
    code: 'internal_error',
    detail: ERROR_DETAILS.internal,
    request_id: REQUEST_ID,
    retry_after_s: DEFAULT_RETRY_AFTER_S,
  };

  it('become a generic 500 that says nothing about them', () => {
    const typeError = new TypeError(
      "Cannot read properties of undefined (reading 'id') at /srv/app/dist/x.js:1:2",
    );
    for (const thrown of [
      typeError,
      new Error(`Bearer ${JWT}`),
      'a string',
      42,
      null,
      undefined,
      { code: 'forbidden', status: 403, detail: 'a fake AppError is not trusted' },
      Object.assign(new Error('Body is not valid JSON'), {
        code: 'FST_ERR_CTP_INVALID_JSON_BODY',
        statusCode: 400,
      }),
    ]) {
      expect(toProblem(thrown, CTX)).toEqual(generic);
    }
  });

  it('keep the instance when one is given', () => {
    expect(toProblem(new Error('x'), { requestId: REQUEST_ID, instance: '/v1/x' })).toEqual({
      ...generic,
      instance: '/v1/x',
    });
  });

  it(
    'never let their message, stack or properties into the problem (property)',
    () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), fc.anything({ maxDepth: 3 }), (text, extra) => {
          const marker = `MARK<${text}>`;
          const err = Object.assign(new Error(marker), { extra, details: marker, code: marker });
          const problem = toProblem(err, CTX);
          expect(JSON.stringify(problem)).not.toContain('MARK<');
          expect(problem).toEqual(generic);
        }),
        { seed: SEED, numRuns: 500 },
      );
    },
    TIMEOUT,
  );
});

describe('every output is a valid problem with a registry code (property)', () => {
  const codeArb = fc.oneof(fc.constantFrom(...ERROR_CODES), fc.string({ maxLength: 20 }));
  const optionsArb = fc.record(
    {
      detail: fc.oneof(fc.string({ maxLength: 300 }), fc.anything({ maxDepth: 1 })),
      retryAfterS: fc.oneof(fc.double(), fc.integer(), fc.anything({ maxDepth: 1 })),
      status: fc.oneof(
        fc.integer({ min: 100, max: 700 }),
        fc.double(),
        fc.anything({ maxDepth: 1 }),
      ),
      errors: fc.oneof(
        fc.array(fc.record({ pointer: fc.string(), code: fc.string(), detail: fc.string() }), {
          maxLength: 5,
        }),
        fc.anything({ maxDepth: 2 }),
      ),
    },
    { requiredKeys: [] },
  );

  it(
    'for any code and options, toProblem never throws and the result validates',
    () => {
      fc.assert(
        fc.property(codeArb, optionsArb, (code, options) => {
          const problem = toProblem(new AppError(code as ErrorCode, options as never), CTX);
          expectValid(problem);
          expect(isErrorCode(problem.code)).toBe(true);
          expect(problem.request_id).toBe(REQUEST_ID);
          const status = errorEntry(problem.code as ErrorCode).status;
          expect(Math.floor(problem.status / 100)).toBe(Math.floor(status / 100));
        }),
        { seed: SEED, numRuns: 2000 },
      );
    },
    TIMEOUT,
  );
});

describe('details and field errors', () => {
  it('replaces secrets that slipped into a detail or a field error', () => {
    const problem = toProblem(
      new AppError('invalid_request', {
        detail: `Header was Bearer ${JWT} and key ${LIVE_KEY}`,
        errors: [{ pointer: `/${LIVE_KEY}`, code: 'invalid', detail: `token ${JWT}` }],
      }),
      CTX,
    );
    const body = JSON.stringify(problem);
    expect(body).not.toContain(JWT);
    expect(body).not.toContain(LIVE_KEY);
    expect(problem.detail).toBe('Header was Bearer [redacted] and key [redacted]');
    expect(problem.errors).toEqual([
      { pointer: '/[redacted]', code: 'invalid', detail: 'token [redacted]' },
    ]);
  });

  it('caps a long detail', () => {
    const problem = toProblem(new AppError('invalid_request', { detail: 'x'.repeat(10_000) }), CTX);
    expect(problem.detail?.length).toBeLessThanOrEqual(2000);
    expectValid(problem);
  });

  it(`sends at most ${MAX_FIELD_ERRORS} field errors`, () => {
    const errors = Array.from({ length: MAX_FIELD_ERRORS + 50 }, (_, i) => ({
      pointer: `/items/${i}`,
      code: 'invalid',
    }));
    const problem = toProblem(validationFailed(errors), CTX);
    expect(problem.errors).toHaveLength(MAX_FIELD_ERRORS);
    expect(problem.errors?.at(-1)?.pointer).toBe(`/items/${MAX_FIELD_ERRORS - 1}`);
  });

  it('returns a fresh object each time and never changes the error', () => {
    const err = validationFailed([{ pointer: '/a', code: 'required' }], 'Fix it.');
    const first = toProblem(err, CTX);
    first.errors?.push({ pointer: '/b', code: 'x' });
    first.detail = 'changed';
    const second = toProblem(err, CTX);
    expect(second.errors).toEqual([{ pointer: '/a', code: 'required' }]);
    expect(second.detail).toBe('Fix it.');
    expect(err.errors).toEqual([{ pointer: '/a', code: 'required' }]);
  });
});

describe('fallbackProblemBody', () => {
  it('is a minimal valid 500 problem with the request id', () => {
    const body = JSON.parse(fallbackProblemBody(REQUEST_ID)) as unknown;
    expectValid(body);
    expect(body).toEqual({
      type: 'https://centcom.dev/errors/internal_error',
      title: 'Internal error',
      status: 500,
      code: 'internal_error',
      request_id: REQUEST_ID,
      retry_after_s: DEFAULT_RETRY_AFTER_S,
    });
  });
});
