/**
 * The error registry (B006): exactly the codes of contracts/errors.json with their status, area,
 * title, retryability and problem type (through B003's generated module), and codeForStatus, the
 * CT-ERR rule 7 fallback from a bare status to a registry code.
 */
import { describe, expect, it } from 'vitest';
import {
  codeForStatus,
  ERROR_CODES,
  ERROR_TYPE_BASE,
  errorEntry,
  isErrorCode,
  isErrorStatus,
  type ErrorCode,
} from '../../src/index.js';
import { readContract } from './helpers.js';

interface RegistryFile {
  base: string;
  errors: {
    code: string;
    status: number;
    area: string;
    retryable: boolean;
    title: string;
    type: string;
  }[];
}

const registry = readContract<RegistryFile>('errors.json');
const registryStatuses = [...new Set(registry.errors.map((e) => e.status))].sort((a, b) => a - b);

describe('error registry', () => {
  it('holds exactly the codes of contracts/errors.json, in the same order', () => {
    expect(ERROR_CODES).toEqual(registry.errors.map((e) => e.code));
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it('gives every code the status, area, title, retryability and type the contract lists', () => {
    expect(ERROR_TYPE_BASE).toBe(registry.base);
    for (const e of registry.errors) {
      expect(isErrorCode(e.code), e.code).toBe(true);
      expect(errorEntry(e.code as ErrorCode)).toEqual({
        status: e.status,
        area: e.area,
        retryable: e.retryable,
        title: e.title,
        type: e.type,
      });
      expect(e.type).toBe(`${ERROR_TYPE_BASE}${e.code}`);
    }
  });

  it('accepts nothing else as a code', () => {
    for (const value of [
      'method_not_allowed',
      'FORBIDDEN',
      'forbidden ',
      '',
      'toString',
      '__proto__',
      'constructor',
      'hasOwnProperty',
      403,
      null,
      undefined,
      {},
      ['forbidden'],
    ]) {
      expect(isErrorCode(value), String(value)).toBe(false);
    }
  });

  it('isErrorStatus accepts the integers 400 to 599 only', () => {
    for (const status of [400, 404, 499, 500, 599]) expect(isErrorStatus(status)).toBe(true);
    for (const status of [399, 600, 200, 404.5, -404, Number.NaN, Infinity, '404', null]) {
      expect(isErrorStatus(status), String(status)).toBe(false);
    }
  });
});

describe('codeForStatus (CT-ERR rule 7)', () => {
  it('maps every status the registry uses to a code sent with that very status', () => {
    expect(registryStatuses.length).toBeGreaterThan(10);
    for (const status of registryStatuses) {
      expect(errorEntry(codeForStatus(status)).status, String(status)).toBe(status);
    }
  });

  it('picks the generic code where the registry has one for the status', () => {
    expect(codeForStatus(400)).toBe('invalid_request');
    expect(codeForStatus(401)).toBe('unauthorized');
    expect(codeForStatus(403)).toBe('forbidden');
    expect(codeForStatus(404)).toBe('not_found');
    expect(codeForStatus(409)).toBe('conflict');
    expect(codeForStatus(410)).toBe('gone');
    expect(codeForStatus(413)).toBe('payload_too_large');
    expect(codeForStatus(422)).toBe('validation_failed');
    expect(codeForStatus(429)).toBe('rate_limited');
    expect(codeForStatus(500)).toBe('internal_error');
    expect(codeForStatus(503)).toBe('service_unavailable');
    for (const status of registryStatuses) {
      const generic = registry.errors.find((e) => e.status === status && e.area === 'generic');
      if (generic !== undefined) expect(codeForStatus(status)).toBe(generic.code);
    }
  });

  it("gives a status without a code of its own its class's generic code", () => {
    for (const status of [405, 406, 408, 414, 418, 425, 431, 451, 499]) {
      expect(codeForStatus(status), String(status)).toBe('invalid_request');
    }
    for (const status of [501, 505, 507, 599]) {
      expect(codeForStatus(status), String(status)).toBe('internal_error');
    }
  });

  it('treats anything that is not an error status as a 500', () => {
    for (const status of [200, 204, 302, 399, 600, 404.5, -1, Number.NaN, Infinity]) {
      expect(codeForStatus(status), String(status)).toBe('internal_error');
    }
  });
});
