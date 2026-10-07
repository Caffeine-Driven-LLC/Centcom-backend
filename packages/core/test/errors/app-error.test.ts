/**
 * AppError and its helpers (B006): every helper throws the registry code and status the card
 * names, options are copied (never shared with the caller), the status override stays inside the
 * code's status class, and a stray code or malformed option never makes the constructor throw.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  isAppError,
  notFound,
  tooManyRequests,
  unauthorized,
  unavailable,
  unprocessable,
  validationFailed,
  type AppErrorOptions,
  type ErrorCode,
  type FieldError,
} from '../../src/index.js';

describe('helpers', () => {
  it.each([
    ['badRequest', badRequest, 'invalid_request', 400],
    ['unauthorized', unauthorized, 'unauthorized', 401],
    ['forbidden', forbidden, 'forbidden', 403],
    ['notFound', notFound, 'not_found', 404],
    ['conflict', conflict, 'conflict', 409],
    ['unprocessable', unprocessable, 'validation_failed', 422],
  ] as const)('%s() is %s with status %i', (_name, helper, code, status) => {
    const bare = helper();
    expect(bare).toBeInstanceOf(AppError);
    expect(bare).toBeInstanceOf(Error);
    expect(bare.code).toBe(code);
    expect(bare.status).toBe(status);
    expect(bare.detail).toBeUndefined();
    expect(bare.message).toBe(code);

    const cause = new Error('underlying');
    const withDetail = helper('Shown to the user.', { cause });
    expect(withDetail.detail).toBe('Shown to the user.');
    expect(withDetail.message).toBe(`${code}: Shown to the user.`);
    expect(withDetail.cause).toBe(cause);
  });

  it('tooManyRequests() is a 429 rate_limited with the retry hint', () => {
    const err = tooManyRequests(30, 'Slow down.');
    expect(err).toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterS: 30,
      detail: 'Slow down.',
    });
  });

  it('unavailable() is a 503 service_unavailable, with or without a retry hint', () => {
    expect(unavailable()).toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(unavailable().retryAfterS).toBeUndefined();
    expect(unavailable(120, 'Back soon.')).toMatchObject({
      retryAfterS: 120,
      detail: 'Back soon.',
    });
  });

  it('validationFailed() is a 422 validation_failed carrying the field errors', () => {
    const errors: FieldError[] = [
      { pointer: '/events/3/qty', code: 'out_of_range', detail: 'must be >= 0' },
    ];
    const err = validationFailed(errors);
    expect(err).toMatchObject({ code: 'validation_failed', status: 422, errors });
  });

  it('validationFailed() takes the issues a @centcom/contracts validator returns as they are', () => {
    const result = validate('api/UsageBatch', { events: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = validationFailed(result.errors);
    expect(err.errors).toEqual(result.errors);
    expect(err.errors?.[0]?.pointer).toBe('/events');
  });
});

describe('AppError', () => {
  it('works for every registry code', () => {
    const err = new AppError('quota_exceeded', {
      detail: 'Monthly agent-minutes used.',
      retryAfterS: 3600,
    });
    expect(err).toMatchObject({ code: 'quota_exceeded', status: 429, retryAfterS: 3600 });
    expect(err.name).toBe('AppError');
    expect(String(err)).toBe('AppError: quota_exceeded: Monthly agent-minutes used.');
    expect(err.stack).toContain('AppError');
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError({ code: 'forbidden', status: 403 })).toBe(false);
  });

  it('has only the properties it was given, and keeps its name off the instance', () => {
    expect(Object.keys(new AppError('forbidden'))).toEqual(['code', 'status']);
    expect(
      Object.keys(new AppError('rate_limited', { detail: 'd', retryAfterS: 1, errors: [] })),
    ).toEqual(['code', 'status', 'detail', 'errors', 'retryAfterS']);
  });

  it('copies and freezes the field errors, keeping only well-formed entries and fields', () => {
    const input = [
      { pointer: '/a', code: 'required', detail: 'is required', extra: 'dropped' },
      { pointer: '/b', code: 'invalid', detail: 42 },
      { pointer: 7, code: 'invalid' },
      { pointer: '/c' },
      null,
      'not an entry',
    ] as unknown as FieldError[];
    const err = new AppError('validation_failed', { errors: input });
    expect(err.errors).toEqual([
      { pointer: '/a', code: 'required', detail: 'is required' },
      { pointer: '/b', code: 'invalid' },
    ]);
    expect(Object.isFrozen(err.errors)).toBe(true);
    expect(Object.isFrozen(err.errors?.[0])).toBe(true);
    (input[0] as { pointer: string }).pointer = '/changed';
    input.length = 0;
    expect(err.errors?.[0]?.pointer).toBe('/a');
    expect(
      new AppError('validation_failed', { errors: 'nope' as unknown as FieldError[] }).errors,
    ).toBeUndefined();
  });

  it('ignores a detail or retry hint of the wrong type instead of throwing', () => {
    const err = new AppError('forbidden', {
      detail: 42,
      retryAfterS: '5',
    } as unknown as AppErrorOptions);
    expect(err.detail).toBeUndefined();
    expect(err.retryAfterS).toBeUndefined();
    expect(err.message).toBe('forbidden');
  });

  describe('status', () => {
    it("is the code's registry status by default", () => {
      expect(new AppError('member_exists').status).toBe(409);
      expect(new AppError('payment_required').status).toBe(402);
    });

    it('takes an override for a status the registry has no code for, within the same class', () => {
      expect(new AppError('invalid_request', { status: 405 }).status).toBe(405);
      expect(new AppError('invalid_request', { status: 414 }).status).toBe(414);
      expect(new AppError('internal_error', { status: 507 }).status).toBe(507);
    });

    it('refuses an override from another class or outside 400-599', () => {
      expect(new AppError('forbidden', { status: 500 }).status).toBe(403);
      expect(new AppError('internal_error', { status: 418 }).status).toBe(500);
      for (const status of [200, 302, 600, 404.5, Number.NaN, -400]) {
        expect(new AppError('not_found', { status }).status, String(status)).toBe(404);
      }
    });

    it('is 500, or the given error status, for a code missing from the registry', () => {
      const stray = 'made_up_code' as ErrorCode;
      expect(new AppError(stray).status).toBe(500);
      expect(new AppError(stray, { status: 418 }).status).toBe(418);
      expect(new AppError(stray, { status: 200 }).status).toBe(500);
    });
  });
});
