/**
 * B062 contract and the reaction stage (acceptance 3; CT-WS-SESSION-EVENTS `reaction`): the
 * fixture is accepted and applied for its sender after sequencing; a code outside the six
 * (`skull`) and a target that is not a frame id are `invalid_frame` and never reach the store; a
 * replayed frame (same sender and id) is applied once; at most 200 reactions per member per minute
 * (the 201st is `rate_limited`, another member is not); a failed write after sequencing is counted
 * and logged without the frame, and the frame still went out.
 */
import { newId, validateEnvelope } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { reaction, stageEnv } from './helpers.js';

describe('reaction frames (acceptance 3)', () => {
  it('applies the fixture shape for its sender, after sequencing', async () => {
    const env = stageEnv();
    const me = env.member();
    const target = newId('msg');
    const frame = reaction(target, 'thumbs', 'add');
    expect(validateEnvelope(frame).ok).toBe(true);
    expect((await env.send(frame, me)).passed).toBe(true);
    expect(env.applied).toEqual([
      { sid: env.sid, op: { seq: 1, from: me, target, code: 'thumbs', op: 'add' } },
    ]);
  });

  it('a remove, even of a reaction never added, is sequenced and handed on (acceptance 1)', async () => {
    const env = stageEnv();
    const me = env.member();
    const target = newId('msg');
    expect((await env.send(reaction(target, 'heart', 'remove'), me)).passed).toBe(true);
    expect(env.applied).toEqual([
      { sid: env.sid, op: { seq: 1, from: me, target, code: 'heart', op: 'remove' } },
    ]);
  });

  it('the limiter down: reactions still go through', async () => {
    const env = stageEnv({ limiterDown: true });
    expect((await env.send(reaction(newId('msg')), env.member())).passed).toBe(true);
    expect(env.applied).toHaveLength(1);
  });

  it("refuses 'skull' and a target that is not a frame id", async () => {
    const env = stageEnv();
    const me = env.member();
    for (const frame of [
      reaction(newId('msg'), 'skull'),
      reaction('agt_01JA3Z8K2M5N7P9Q0R1S2T3V4W'),
      reaction('msg_not-an-id'),
    ]) {
      const out = await env.send(frame, me);
      expect(out.passed).toBe(false);
      expect(out.error).toMatchObject({ ref: frame['id'], p: { code: 'invalid_frame' } });
    }
    expect(env.applied).toEqual([]);
  });

  it('a replayed frame is applied once (acceptance 6)', async () => {
    const env = stageEnv();
    const me = env.member();
    const frame = reaction(newId('msg'));
    await env.send(frame, me);
    await env.send(frame, me);
    expect(env.applied).toHaveLength(1);
  });

  it('caps a member at 200 a minute', async () => {
    const env = stageEnv();
    const [me, other] = [env.member(), env.member()];
    for (let i = 0; i < 200; i++)
      expect((await env.send(reaction(newId('msg')), me)).passed).toBe(true);
    const out = await env.send(reaction(newId('msg')), me);
    expect(out.passed).toBe(false);
    expect(out.error).toMatchObject({ p: { code: 'rate_limited' } });
    expect((await env.send(reaction(newId('msg')), other)).passed).toBe(true);
    env.clock.now += 60_000;
    expect((await env.send(reaction(newId('msg')), me)).passed).toBe(true);
  }, 30_000);

  it('a failed write is counted and logged; the frame still went out', async () => {
    const env = stageEnv();
    env.fail.on = true;
    const target = newId('msg');
    expect((await env.send(reaction(target), env.member())).passed).toBe(true);
    expect(env.metrics.count('relay_reaction_writes_failed_total', { kind: 'reaction' })).toBe(1);
    expect(env.captured.raw()).toContain('reactions.write_failed');
    expect(env.captured.raw()).not.toContain(target);
  });
});
