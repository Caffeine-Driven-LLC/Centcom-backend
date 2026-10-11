/**
 * B057 lifecycle and idempotency: a host's spawn in a command-post session creates one record and
 * a resend of the same frame creates no second one (acceptance 1); `agent.state` for an unknown
 * agent is `invalid_frame` to the sender, for an exited one ignored (acceptance 4); `agent.exit`
 * ends the agent, lowers `countLive`, and nothing brings it back (acceptance 6); malformed and
 * future-field frames are tolerated as the card's guardrails say.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { agentEnv, exit, spawn, state } from './helpers.js';

describe('lifecycle and idempotency', () => {
  it('a host spawn creates one record; the same frame resent creates none (acceptance 1)', async () => {
    const env = agentEnv();
    const frame = spawn({ owner: env.host.memberId });
    const first = await env.send(frame, env.host);
    expect(first).toEqual({ outcome: 'sequenced', seq: 1 });
    expect(env.registry.list(env.sid)).toEqual([
      {
        agentId: frame.agentId,
        owner: env.host.memberId,
        mode: 'command_post',
        state: '',
        since: '2026-10-10T12:00:00.000Z',
      },
    ]);
    expect(await env.send(frame, env.host)).toEqual({ outcome: 'resent' });
    expect(env.registry.list(env.sid)).toHaveLength(1);
    expect(env.registry.countLive(env.sid)).toBe(1);
    expect(env.seq.sequenced).toHaveLength(1);
    // Another frame spawning the same agent id is refused.
    const again = spawn({ owner: env.host.memberId, agent: frame.agentId });
    expect(await env.send(again, env.host)).toMatchObject({
      outcome: 'refused',
      code: 'invalid_frame',
    });
  });

  it('records state changes in order', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    expect(
      await env.send(state(s.agentId, 'thinking', '2026-10-10T12:00:01.000Z'), env.host),
    ).toMatchObject({
      outcome: 'sequenced',
    });
    env.clock.now += 1_000;
    await env.send(state(s.agentId, 'editing-file', '2026-10-10T12:00:02.000Z'), env.host);
    expect(env.registry.get(env.sid, s.agentId)).toMatchObject({
      state: 'editing-file',
      since: '2026-10-10T12:00:02.000Z',
    });
  });

  it('agent.state for an unknown agent: invalid_frame; for an exited one: ignored (acceptance 4)', async () => {
    const env = agentEnv();
    expect(await env.send(state(newId('agt'), 'thinking'), env.host)).toMatchObject({
      outcome: 'refused',
      code: 'invalid_frame',
    });
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    await env.send(exit(s.agentId), env.host);
    const before = env.seq.sequenced.length;
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toEqual({
      outcome: 'dropped',
      reason: 'exited',
    });
    expect(env.seq.sequenced).toHaveLength(before);
    expect(env.recorded.count('relay_agent_state_dropped_total', { reason: 'exited' })).toBe(1);
  });

  it('agent.exit ends the agent, lowers countLive, and a later state does not resurrect it (acceptance 6)', async () => {
    const env = agentEnv();
    const a = spawn({ owner: env.host.memberId });
    const b = spawn({ owner: env.host.memberId });
    await env.send(a, env.host);
    await env.send(b, env.host);
    expect(env.registry.countLive(env.sid)).toBe(2);
    expect(await env.send(exit(a.agentId, 'error', 'crashed'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
    expect(env.registry.countLive(env.sid)).toBe(1);
    expect(env.registry.get(env.sid, a.agentId)?.exited).toEqual({
      outcome: 'error',
      errorCode: 'crashed',
    });
    await env.send(state(a.agentId, 'thinking'), env.host);
    await env.send(exit(a.agentId, 'ok'), env.host);
    expect(env.registry.get(env.sid, a.agentId)?.exited).toEqual({
      outcome: 'error',
      errorCode: 'crashed',
    });
    expect(env.registry.countLive(env.sid)).toBe(1);
    // Exit of an unknown agent: invalid_frame.
    expect(await env.send(exit(newId('agt')), env.host)).toMatchObject({ code: 'invalid_frame' });
  });

  it('refuses malformed payloads with invalid_frame and tolerates unknown fields', async () => {
    const env = agentEnv();
    for (const p of [
      null,
      'x',
      { agent_id: 'nope', owner: env.host.memberId, mode: 'command_post' },
      { agent_id: newId('agt'), owner: env.host.memberId, mode: 'solo' },
      { agent_id: newId('agt'), mode: 'command_post' },
    ]) {
      expect(await env.send({ id: newId('msg'), k: 'agent.spawn', p }, env.host)).toMatchObject({
        outcome: 'refused',
        code: 'invalid_frame',
      });
    }
    const future = spawn({ owner: env.host.memberId });
    (future.p as Record<string, unknown>)['priority'] = 'high';
    expect(await env.send(future, env.host)).toMatchObject({ outcome: 'sequenced' });
    expect(
      await env.send(
        { id: newId('msg'), k: 'agent.state', p: { agent_id: future.agentId } },
        env.host,
      ),
    ).toMatchObject({
      code: 'invalid_frame',
    });
    expect(env.registry.list(env.sid)).toHaveLength(1);
  });

  it('records nothing when sequencing refuses the frame', async () => {
    const env = agentEnv();
    env.seq.refusing = true;
    expect(await env.send(spawn({ owner: env.host.memberId }), env.host)).toEqual({
      outcome: 'unsequenced',
    });
    expect(env.registry.list(env.sid)).toEqual([]);
  });

  it('uses the injected state validator (B058)', async () => {
    const env = agentEnv();
    env.registry.setStateValidator((name) => name === 'thinking');
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    expect(await env.send(state(s.agentId, 'dancing'), env.host)).toMatchObject({
      code: 'invalid_frame',
    });
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
  });
});
