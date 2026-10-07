/**
 * isRetryable (B006 acceptance 7): the CT-ERR retry table (contracts/00-foundations.md), which
 * clients and the server obey alike. POST is retried only with an Idempotency-Key (CT-PAGE).
 */
import { describe, expect, it } from 'vitest';
import { isRetryable } from '../../src/index.js';

/** Methods RFC 9110 defines as idempotent. */
const IDEMPOTENT = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'];

/**
 * The table, row by row: for each status, whether a GET, a PATCH, a POST without and a POST with an
 * Idempotency-Key may be retried. The key does not change the answer for the other methods.
 */
const TABLE: readonly [
  status: number,
  get: boolean,
  patch: boolean,
  post: boolean,
  postKey: boolean,
][] = [
  // 400, 401*, 403, 404, 409, 410, 422: no, fix the request.
  [400, false, false, false, false],
  [401, false, false, false, false],
  [403, false, false, false, false],
  [404, false, false, false, false],
  [409, false, false, false, false],
  [410, false, false, false, false],
  [422, false, false, false, false],
  // 408, 425, 429: yes, honouring Retry-After (a POST needs a key).
  [408, true, true, false, true],
  [425, true, true, false, true],
  [429, true, true, false, true],
  // 500, 502, 503, 504: idempotent requests only.
  [500, true, false, false, true],
  [502, true, false, false, true],
  [503, true, false, false, true],
  [504, true, false, false, true],
];

describe('isRetryable (CT-ERR retry table)', () => {
  it('answers the three cases of acceptance 7', () => {
    expect(isRetryable(503, 'POST', false)).toBe(false);
    expect(isRetryable(503, 'GET', false)).toBe(true);
    expect(isRetryable(429, 'POST', false)).toBe(false);
  });

  it.each(TABLE)(
    'status %i: GET %s, PATCH %s, POST %s, POST with a key %s',
    (status, get, patch, post, postKey) => {
      expect(isRetryable(status, 'GET', false)).toBe(get);
      expect(isRetryable(status, 'GET', true)).toBe(get);
      expect(isRetryable(status, 'PATCH', false)).toBe(patch);
      expect(isRetryable(status, 'PATCH', true)).toBe(patch);
      expect(isRetryable(status, 'POST', false)).toBe(post);
      expect(isRetryable(status, 'POST', true)).toBe(postKey);
      for (const method of IDEMPOTENT) {
        expect(isRetryable(status, method, false), method).toBe(get);
        expect(isRetryable(status, method, true), method).toBe(get);
      }
    },
  );

  it('never retries a status outside the table', () => {
    const inTable = new Set(TABLE.map(([status]) => status));
    for (let status = 400; status <= 599; status++) {
      if (inTable.has(status)) continue;
      for (const method of [...IDEMPOTENT, 'POST', 'PATCH']) {
        expect(isRetryable(status, method, true), `${status} ${method}`).toBe(false);
      }
    }
  });

  it('never retries a POST without an Idempotency-Key, whatever the status', () => {
    for (let status = 400; status <= 599; status++) {
      expect(isRetryable(status, 'POST', false), String(status)).toBe(false);
    }
  });

  it('compares the method case-insensitively', () => {
    expect(isRetryable(503, 'get', false)).toBe(true);
    expect(isRetryable(503, 'Delete', false)).toBe(true);
    expect(isRetryable(429, 'post', false)).toBe(false);
    expect(isRetryable(429, 'post', true)).toBe(true);
    expect(isRetryable(503, 'patch', true)).toBe(false);
  });
});
