/**
 * B057 contract fixtures (CT-WS-SESSION-EVENTS): the `agent.spawn`, `agent.state` and
 * `agent.exit` fixtures validate against the generated schemas, and the registry accepts each of
 * them as a client would send it (cleartext `p` only, `ct` opaque), recording exactly the fixture's
 * values.
 */
import { validateEvent } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentFrame } from '../../src/agents/ports.js';
import { agentEnv, fixture } from './helpers.js';

describe('agent.* fixtures', () => {
  it('validate against the event schemas', () => {
    for (const kind of ['agent.spawn', 'agent.state', 'agent.exit'] as const) {
      expect(validateEvent(kind, fixture(kind)['p']).ok, kind).toBe(true);
    }
  });

  it('go through the registry: spawn, state, exit, with the fixture values recorded', async () => {
    const env = agentEnv();
    const frames = (['agent.spawn', 'agent.state', 'agent.exit'] as const).map((kind) => {
      const f = fixture(kind);
      return { id: `${String(f['id'])}-${kind}`, k: kind, p: f['p'] } as AgentFrame;
    });
    const p = fixture('agent.spawn')['p'] as Record<string, string>;
    // The fixture's owner sends as the host.
    const host = { memberId: p['owner'] ?? '', role: 'host' as const };
    for (const frame of frames) {
      expect(await env.send(frame, host), frame.k).toMatchObject({ outcome: 'sequenced' });
    }
    expect(env.registry.get(env.sid, p['agent_id'] ?? '')).toEqual({
      agentId: p['agent_id'],
      owner: p['owner'],
      mode: 'command_post',
      state: 'approved',
      since: '2026-10-05T18:07:41.123Z',
      exited: { outcome: 'ok', errorCode: 'short text' },
    });
  });
});
