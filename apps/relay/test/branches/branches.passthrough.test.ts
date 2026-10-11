/**
 * B061 pass-through (acceptance 2; guardrail: never drop, merge or reorder sequenced
 * `branch.update` frames): 5 updates for one agent within 2 s are all sequenced, in the order sent,
 * each unchanged; the relay does not coalesce (B041's per-member rate limit is the only limit, and
 * it is applied by the sequencer, after this stage). Other frames pass untouched.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { branchUpdate, signalEnv } from './helpers.js';

describe('no coalescing (acceptance 2)', () => {
  it('5 updates within 2 s are all sequenced and delivered in order', async () => {
    const env = signalEnv();
    const frames = Array.from({ length: 5 }, () => branchUpdate());
    for (const frame of frames) {
      env.clock.now += 300;
      expect((await env.send(frame, env.host)).passed).toBe(true);
    }
    expect(env.sequenced.map((s) => s.frame)).toEqual(frames);
    expect(env.sequenced.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(env.recorded.count('relay_branch_updates_total')).toBe(5);
  });

  it('concurrent updates are all handed on (the stage holds none back)', async () => {
    const env = signalEnv();
    const frames = Array.from({ length: 5 }, () => branchUpdate());
    const outs = await Promise.all(frames.map((f) => env.send(f, env.host)));
    expect(outs.every((o) => o.passed)).toBe(true);
    expect(env.sequenced).toHaveLength(5);
  });

  it('B041 still limits them: the stage hands every one on and counts only those stored', async () => {
    // B041's per-member token bucket (seq.ratelimit.test.ts) runs after this stage, for every
    // event kind alike; here a sequencer that refuses past 3 stands in for it.
    const env = signalEnv();
    const stage = (await import('../../src/branches/stage.js')).branchStage({
      branches: env.branches,
      conflicts: env.conflicts,
      rooms: {
        locate: () =>
          ({ room: { sid: env.sid }, member: { id: env.host.memberId, role: 'host' } }) as never,
      },
    });
    let reached = 0;
    const sent: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      const frame = branchUpdate();
      const state: Record<string, unknown> = {};
      await stage(
        {
          connection: { send: (f: Record<string, unknown>) => (sent.push(f), true) } as never,
          raw: null,
          frame,
          state,
        },
        () => {
          reached += 1;
          if (reached <= 3) state['seq.frame'] = { ...frame, seq: reached };
          return Promise.resolve();
        },
      );
    }
    expect(reached).toBe(5);
    expect(sent).toEqual([]);
    expect(env.recorded.count('relay_branch_updates_total')).toBe(3);
  });

  it('other frames pass untouched, whatever the sender', async () => {
    const env = signalEnv();
    for (const by of [env.host, env.editor, env.viewer]) {
      const frame = { v: 1, t: 'event', id: newId('msg'), k: 'message.user', ct: { c: 'x' } };
      expect(await env.send(frame, by)).toMatchObject({ passed: true, sent: [] });
    }
  });
});
