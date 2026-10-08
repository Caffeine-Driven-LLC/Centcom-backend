/**
 * The guards around providers (B064 guardrails and failure modes): the SSRF checks (https only,
 * no credentials, no internal names or addresses at registration; every resolved address public
 * at send), the HTTP status mapping, the semaphore's cap, and the circuit breaker (10 failures in a
 * row open it for 60 s; a success resets the count).
 */
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_OPEN_MS,
  CIRCUIT_THRESHOLD,
  CircuitBreaker,
  endpointProblem,
  isInternalAddress,
  outcomeOfStatus,
  resolvesPublic,
  Semaphore,
} from '../../../src/modules/notifications/push/providers.js';

describe('endpointProblem', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', undefined],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', undefined],
    ['https://8.8.8.8/push', undefined],
    ['http://fcm.googleapis.com/fcm/send/abc', 'must be an https URL'],
    ['not a url', 'must be an https URL'],
    ['https://user:pw@push.example.com/x', 'must not contain credentials'],
    ['https://localhost/x', 'must be a public host'],
    ['https://push.local/x', 'must be a public host'],
    ['https://metadata.internal/x', 'must be a public host'],
    ['https://intranet/x', 'must be a public host'],
    ['https://127.0.0.1/x', 'must be a public host'],
    ['https://10.0.0.5/x', 'must be a public host'],
    ['https://192.168.1.1/x', 'must be a public host'],
    ['https://169.254.169.254/latest', 'must be a public host'],
    ['https://[::1]/x', 'must be a public host'],
    ['https://[fd12::1]/x', 'must be a public host'],
    ['https://[::ffff:10.0.0.1]/x', 'must be a public host'],
  ])('%s', (endpoint, problem) => {
    expect(endpointProblem(endpoint)).toBe(problem);
  });
});

describe('isInternalAddress', () => {
  it.each([
    ['0.0.0.0', true],
    ['100.64.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['198.18.0.1', true],
    ['224.0.0.1', true],
    ['172.32.0.1', false],
    ['93.184.216.34', false],
    ['::', true],
    ['fe80::1', true],
    ['2001:4860:4860::8888', false],
    ['not-an-ip', true],
  ])('%s is internal: %s', (address, internal) => {
    expect(isInternalAddress(address)).toBe(internal);
  });
});

describe('resolvesPublic', () => {
  it('needs every resolved address public', async () => {
    const url = 'https://push.example.com/x';
    expect(await resolvesPublic(url, () => Promise.resolve(['93.184.216.34']))).toBe(true);
    expect(await resolvesPublic(url, () => Promise.resolve(['93.184.216.34', '10.0.0.1']))).toBe(
      false,
    );
    expect(await resolvesPublic(url, () => Promise.resolve([]))).toBe(false);
    expect(await resolvesPublic(url, () => Promise.reject(new Error('ENOTFOUND')))).toBe(false);
    expect(
      await resolvesPublic('https://127.0.0.1/x', () => Promise.resolve(['93.184.216.34'])),
    ).toBe(false);
    expect(await resolvesPublic('::bad::', () => Promise.resolve(['93.184.216.34']))).toBe(false);
  });
});

describe('outcomeOfStatus', () => {
  it.each([
    [200, 'sent'],
    [201, 'sent'],
    [404, 'gone'],
    [410, 'gone'],
    [408, 'retry'],
    [429, 'retry'],
    [502, 'retry'],
    [400, 'failed'],
    [413, 'failed'],
  ])('%i is %s', (status, result) => {
    expect(outcomeOfStatus(status).result).toBe(result);
  });
});

describe('Semaphore', () => {
  it('never runs more than its max at once', async () => {
    const semaphore = new Semaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 50 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(semaphore.peak).toBe(3);
  });

  it('frees its slot when a task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(semaphore.run(() => Promise.resolve(7))).resolves.toBe(7);
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});

describe('CircuitBreaker', () => {
  it('opens after 10 failures in a row for 60 s; a success resets the count', () => {
    let now = 0;
    const breaker = new CircuitBreaker(() => now);
    for (let i = 0; i < CIRCUIT_THRESHOLD - 1; i += 1) breaker.failure();
    breaker.success();
    for (let i = 0; i < CIRCUIT_THRESHOLD - 1; i += 1) breaker.failure();
    expect(breaker.openFor()).toBe(0);
    breaker.failure();
    expect(breaker.openFor()).toBe(CIRCUIT_OPEN_MS);
    now += CIRCUIT_OPEN_MS - 1;
    expect(breaker.openFor()).toBe(1);
    now += 1;
    expect(breaker.openFor()).toBe(0);
  });
});
