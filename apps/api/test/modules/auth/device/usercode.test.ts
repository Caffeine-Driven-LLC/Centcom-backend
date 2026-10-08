/**
 * User codes (B016 acceptance 1; card test usercode.test.ts): the CT-AUTH alphabet, 100 000 codes
 * without a forbidden character, every character used, normalisation of what people type, and a
 * retry when a pending grant already holds the code drawn.
 */
import { describe, expect, it } from 'vitest';
import {
  DeviceGrantService,
  USER_CODE_ATTEMPTS,
} from '../../../../src/modules/auth/device/service.js';
import type { DeviceGrantStore } from '../../../../src/modules/auth/device/store.js';
import {
  formatUserCode,
  generateUserCode,
  normaliseUserCode,
  USER_CODE_ALPHABET,
  USER_CODE_SHAPE,
} from '../../../../src/modules/auth/device/usercode.js';
import { deviceHarness, memoryGrantStore, startBody, testClock } from './helpers.js';
import { createMemoryRedis } from '@centcom/core';

describe('the alphabet', () => {
  it('is A-Z and 2-9 without 0, O, 1, I and L: 31 characters', () => {
    expect(USER_CODE_ALPHABET).toHaveLength(31);
    expect(new Set(USER_CODE_ALPHABET).size).toBe(31);
    for (const forbidden of '0O1IL') expect(USER_CODE_ALPHABET).not.toContain(forbidden);
    for (const ch of USER_CODE_ALPHABET) expect(ch).toMatch(/^[A-Z2-9]$/);
  });

  it('gives 100 000 codes with no forbidden character, using every allowed one', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      const code = generateUserCode();
      if (!USER_CODE_SHAPE.test(code)) throw new Error(`bad code ${code}`);
      if (/[0O1IL]/.test(code)) throw new Error(`forbidden character in ${code}`);
      for (const ch of code) seen.add(ch);
    }
    expect(seen.size).toBe(31);
  });

  it('draws again on bytes that would bias the alphabet (248 and up)', () => {
    // 255, 248 and 249 are dropped; then 0..4 give A..E, 31 gives A again (31 % 31), 247 the last
    // character (247 % 31 = 30), and the second call's 7 gives H.
    const calls = [
      [255, 248, 249, 0, 1, 2, 3, 4, 31, 247, 250, 251, 252, 253, 254, 255],
      [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ];
    const rng = (size: number): Uint8Array => Uint8Array.from((calls.shift() ?? []).slice(0, size));
    expect(generateUserCode(rng)).toBe('ABCDEA9H');
  });
});

describe('formatting and normalising', () => {
  it('shows a code as ABCD-EFGH', () => {
    expect(formatUserCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it.each([
    ['ABCD-EFGH', 'ABCDEFGH'],
    ['abcd-efgh', 'ABCDEFGH'],
    ['ABCDEFGH', 'ABCDEFGH'],
    ['abcdefgh', 'ABCDEFGH'],
    ['  wxyz 2345 ', 'WXYZ2345'],
    ['wxyz-2345\n', 'WXYZ2345'],
  ])('reads %j as %s', (typed, code) => {
    expect(normaliseUserCode(typed)).toBe(code);
  });

  it.each([
    'ABCD-EFG',
    'ABCD-EFGHJ',
    'ABCD--EFGH',
    'AB-CD-EFGH',
    'ABCD-EFG0',
    'ABCD-EFGO',
    'ABCD-EFG1',
    'ABCD-EFGI',
    'ABCD-EFGL',
    'ABCD_EFGH',
    '',
    'x'.repeat(40),
  ])('refuses %j', (typed) => {
    expect(normaliseUserCode(typed)).toBeNull();
  });

  it('refuses what is not a string', () => {
    for (const value of [undefined, null, 12345678, ['ABCDEFGH'], { code: 'ABCDEFGH' }]) {
      expect(normaliseUserCode(value)).toBeNull();
    }
  });
});

describe('collisions', () => {
  it('draws another code when a pending grant already holds the first one', async () => {
    const h = await deviceHarness();
    const first = await h.start();
    const held = String(first.body['user_code']).replace('-', '');
    // The randomness replays the held code first, then gives a fresh one.
    const replay = [...held].map((ch) => USER_CODE_ALPHABET.indexOf(ch));
    let draws = 0;
    const random = (size: number): Uint8Array => {
      if (size === 32) return new Uint8Array(32).fill(7);
      draws++;
      return Uint8Array.from({ length: size }, (_, i) => (draws === 1 ? (replay[i] ?? 0) : i + 1));
    };
    const service = new DeviceGrantService({
      store: h.store,
      kv: h.redis.kv,
      now: h.clock.now,
      random,
    });
    const second = await service.start(startBody());
    expect(draws).toBe(2);
    expect(second.user_code).not.toBe(first.body['user_code']);
    expect(second.user_code).toBe('BCDE-FGHJ');
  });

  it(`gives up with a 503 after ${USER_CODE_ATTEMPTS} taken codes`, async () => {
    const clock = testClock();
    const store: DeviceGrantStore = {
      ...memoryGrantStore(new Map()),
      insert: () => Promise.resolve('user_code_taken'),
    };
    const service = new DeviceGrantService({
      store,
      kv: createMemoryRedis(clock.now).kv,
      now: clock.now,
    });
    await expect(service.start(startBody())).rejects.toMatchObject({
      code: 'service_unavailable',
      retryAfterS: 1,
    });
  });
});
