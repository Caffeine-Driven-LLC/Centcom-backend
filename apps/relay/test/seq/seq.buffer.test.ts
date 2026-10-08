/**
 * The hot buffer on the in-memory store (B041 acceptance 6): the shared suite (`buffer-suite.ts`,
 * also run on Redis), the trimming rule on its own, and the configuration that bounds it.
 */
import { ConfigError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { loadSeqConfig } from '../../src/seq/config.js';
import { createMemorySeqStore } from '../../src/seq/memory-store.js';
import { dropCount, TRIM_STEP } from '../../src/seq/retention.js';
import { defineBufferSuite } from './buffer-suite.js';

defineBufferSuite('in memory', (limits) => Promise.resolve(createMemorySeqStore(limits)));

describe('dropCount', () => {
  const limits = { minFrames: 5, minAgeMs: 100, maxFrames: 10 };
  const at = (times: number[]) => (i: number) => times[i] ?? Number.POSITIVE_INFINITY;

  it('drops what is over the cap first, then aged frames down to the floor', () => {
    expect(dropCount(12, at(Array(12).fill(1_000)), 1_000, limits)).toBe(2);
    expect(dropCount(8, at([0, 0, 0, 0, 0, 0, 0, 0]), 1_000, limits)).toBe(3);
    expect(dropCount(8, at([0, 0, 950, 950, 950, 950, 950, 950]), 1_000, limits)).toBe(2);
    expect(dropCount(5, at([0, 0, 0, 0, 0]), 1_000, limits)).toBe(0);
  });

  it('keeps a frame received exactly minAgeMs ago, and looks at most TRIM_STEP frames deep', () => {
    expect(dropCount(6, at([900, 900, 900, 900, 900, 900]), 1_000, limits)).toBe(0);
    const big = { minFrames: 1, minAgeMs: 0, maxFrames: 10_000 };
    expect(dropCount(1_000, () => 0, 1_000, big)).toBe(TRIM_STEP);
  });
});

describe('buffer configuration', () => {
  it('defaults to the CT-WS-ENVELOPE values', () => {
    expect(loadSeqConfig({})).toEqual({
      rate: 30,
      burst: 100,
      buffer: { minFrames: 5_000, minAgeMs: 600_000, maxFrames: 20_000 },
    });
  });

  it('reads every key, and refuses a floor above the cap or values out of range', () => {
    expect(
      loadSeqConfig({
        RELAY_SEQ_RATE: '10',
        RELAY_SEQ_BURST: '20',
        RELAY_BUF_MIN_FRAMES: '100',
        RELAY_BUF_MIN_AGE_S: '0',
        RELAY_BUF_MAX_FRAMES: '100',
      }),
    ).toEqual({ rate: 10, burst: 20, buffer: { minFrames: 100, minAgeMs: 0, maxFrames: 100 } });
    for (const env of [
      { RELAY_BUF_MIN_FRAMES: '30000' },
      { RELAY_BUF_MAX_FRAMES: '0' },
      { RELAY_BUF_MIN_AGE_S: '-1' },
      { RELAY_SEQ_RATE: '0' },
      { RELAY_SEQ_BURST: 'many' },
    ]) {
      expect(() => loadSeqConfig(env)).toThrow(ConfigError);
    }
  });
});
