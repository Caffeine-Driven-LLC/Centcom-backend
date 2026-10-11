/**
 * B058 tolerance (acceptance 5; CT-STATE-MAP rule 1): through the relay's integration path (the
 * check the agents module installs on B057's registry, `agentStateCheck`), an unknown state is
 * forwarded (sequenced), logged at debug and counted in `relay_agent_state_unknown_total`, never
 * an error; client-local and agent-level states are forwarded uncounted (CT-STATE-MAP: the relay
 * validates against all keys, tolerant); a value that is not a state name is `invalid_frame`. The
 * agents module installs that check on `ctx.agents`.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it, vi } from 'vitest';
import relayModule from '../../src/agents/module.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import { agentStateCheck } from '../../src/agents/state/validator.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline } from '../../src/pipeline.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { agentEnv, spawn, state } from '../agents/helpers.js';

/** A registry with the relay's state check over a recording logger and metrics. */
function withCheck() {
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const env = agentEnv({
    overrides: {
      validateState: agentStateCheck({ metrics: recorded.metrics, logger: captured.logger }),
    },
  });
  return { env, captured, recorded };
}

describe('unknown states (acceptance 5)', () => {
  it('forwards an unknown state, logs it at debug and counts it, never an error', async () => {
    const { env, captured, recorded } = withCheck();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    expect(await env.send(state(s.agentId, 'dancing'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
    expect(env.registry.get(env.sid, s.agentId)?.state).toBe('dancing');
    expect(recorded.count('relay_agent_state_unknown_total')).toBe(1);
    const line = captured.lines().find((l) => l['msg'] === 'agents.state_unknown');
    expect(line).toMatchObject({ level: 'debug', kind: 'agent.state' });
    // The state name itself is not logged.
    expect(captured.raw()).not.toContain('dancing');
  });

  it('forwards client-local and agent-level states too (the relay validates against all keys), counting neither', async () => {
    const { env, recorded } = withCheck();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    for (const name of ['offline', 'quota-reached', 'teammate-joins', 'thinking']) {
      env.clock.now += 1_000;
      expect(await env.send(state(s.agentId, name), env.host), name).toMatchObject({
        outcome: 'sequenced',
      });
    }
    expect(recorded.count('relay_agent_state_unknown_total')).toBe(0);
  });

  it('refuses a state that is not a state name at all, counting nothing', async () => {
    const { env, recorded } = withCheck();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    for (const bad of [42, null, '', 'THINKING', 'a b', 'thinking-', 'x'.repeat(65)]) {
      const frame = state(s.agentId, 'idle');
      (frame.p as Record<string, unknown>)['state'] = bad;
      expect(await env.send(frame, env.host), String(bad)).toMatchObject({
        outcome: 'refused',
        code: 'invalid_frame',
      });
    }
    const late = state(s.agentId, 'dancing');
    (late.p as Record<string, unknown>)['since'] = 'yesterday';
    expect(await env.send(late, env.host)).toMatchObject({ code: 'invalid_frame' });
    expect(recorded.count('relay_agent_state_unknown_total')).toBe(0);
  });

  it('the agents module installs the check on ctx.agents', async () => {
    const ctx = {
      log: captureLogger().logger,
      metrics: recordingMetrics().metrics,
      clock: Date.now,
      db: {},
      redis: createMemoryRedis(),
      pipeline: new FramePipeline(),
      onConnection: () => undefined,
      onShutdown: () => undefined,
    } as unknown as RelayContext;
    const spy = vi.spyOn(AgentRegistry.prototype, 'setStateValidator');
    try {
      await relayModule.register(ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      const check = spy.mock.calls[0]?.[0];
      expect(check?.('thinking')).toBe(true);
      expect(check?.('offline')).toBe(true);
      expect(check?.('dancing')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
