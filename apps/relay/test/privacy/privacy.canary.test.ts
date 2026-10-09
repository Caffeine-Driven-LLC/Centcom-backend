/**
 * The canary suite (B050; tests "privacy.canary.test.ts", acceptance 3 and 6, guardrails "canary
 * tests at debug level against every sequenced kind" and "the suite proves it can fail"): a run
 * across every kind a client may send finds the canary nowhere outside ciphertext (logs at trace,
 * metric labels, hot buffer, durable log, error frames, other members' clear parts), and no `ses_` or
 * `mem_` in any metric label. Negative controls: a module that logs a frame's `ct.c` under an
 * allowlisted field (`reason`; B005 already redacts `code`) makes the run report a leak in the logs; one that logs `{ ct }` is scrubbed
 * (the log scrubber at work, so no leak).
 */
import { describe, expect, it } from 'vitest';
import type { RelayModule } from '../../src/modules.js';
import { newCanary, privacyCanaryRun, privacyRelay } from './canary.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A module that logs something of every frame with a `ct`, at debug. */
const leaking = (
  fields: (ct: Record<string, unknown>) => Record<string, unknown>,
): RelayModule => ({
  name: 'leak',
  order: 31,
  register(ctx) {
    ctx.pipeline.use(31, async (fc, next) => {
      const frame = fc.frame;
      if (isRecord(frame) && isRecord(frame['ct'])) ctx.log.debug(fields(frame['ct']), 'test.leak');
      await next();
    });
    return undefined;
  },
});

describe('the canary run (acceptance 3 and 6)', () => {
  it('finds no canary outside ciphertext, across every client kind, and no ids in labels', async () => {
    const relay = await privacyRelay();
    try {
      const result = await privacyCanaryRun({ relay });
      expect(result.kinds).toBeGreaterThanOrEqual(35);
      expect(result.leaks).toEqual([]);
      expect(result.idLabels).toBe(false);
    } finally {
      await relay.stop();
    }
  }, 60_000);

  it('reports a leak when a module logs ct.c under an allowlisted field (the suite can fail)', async () => {
    const relay = await privacyRelay([leaking((ct) => ({ reason: ct['c'] }))]);
    try {
      const result = await privacyCanaryRun({ relay, canary: newCanary() });
      expect(result.leaks.map((l) => l.where)).toContain('logs');
    } finally {
      await relay.stop();
    }
  }, 60_000);

  it('a module that logs { ct } is scrubbed: no leak', async () => {
    const relay = await privacyRelay([leaking((ct) => ({ ct }))]);
    try {
      const result = await privacyCanaryRun({ relay });
      expect(result.leaks).toEqual([]);
    } finally {
      await relay.stop();
    }
  }, 60_000);
});
