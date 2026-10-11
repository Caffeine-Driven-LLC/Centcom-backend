/**
 * B061 `branch.update` (acceptance 1): a frame with a cleartext `p` (even empty) or without `ct`
 * is refused `invalid_frame` and not sequenced; a valid frame is sequenced and handed on
 * unchanged (`ct` byte-identical; the stage never rewrites the frame); the fixture validates.
 */
import { validateEnvelope } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { branchUpdate, signalEnv } from './helpers.js';

describe('branch.update validation (acceptance 1)', () => {
  it('refuses a p, even empty, and a missing ct', async () => {
    const env = signalEnv();
    for (const frame of [
      branchUpdate({ p: { agent_id: 'agt_01JA3Z8K2M5N7P9Q0R1S2T3V4W' } }),
      branchUpdate({ p: {} }),
      branchUpdate({ ct: undefined }),
      branchUpdate({ ct: 'AAAA' }),
    ]) {
      const out = await env.send(frame, env.host);
      expect(out.passed).toBe(false);
      expect(out.error).toMatchObject({ ref: frame['id'], p: { code: 'invalid_frame' } });
    }
    expect(env.sequenced).toEqual([]);
  });

  it('sequences a valid frame unchanged: ct byte-identical', async () => {
    const env = signalEnv();
    const frame = branchUpdate();
    const before = JSON.stringify(frame['ct']);
    const out = await env.send(frame, env.host);
    expect(out).toMatchObject({ passed: true, sent: [] });
    expect(env.sequenced).toHaveLength(1);
    expect(env.sequenced[0]?.frame).toBe(frame);
    expect(JSON.stringify(env.sequenced[0]?.frame['ct'])).toBe(before);
    expect(env.recorded.count('relay_branch_updates_total')).toBe(1);
  });

  it('the fixture is a valid frame, and one with a p is not (the codec refuses it first)', () => {
    const frame = branchUpdate();
    expect(validateEnvelope(frame).ok).toBe(true);
    expect(validateEnvelope({ ...frame, p: {} }).ok).toBe(false);
  });
});
