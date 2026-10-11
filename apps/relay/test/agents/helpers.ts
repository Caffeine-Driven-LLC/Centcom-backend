/**
 * Test helpers for the agent registry (B057): `agent.*` frames built from
 * `contracts/fixtures/events/agent.*.json` with fresh ids, a sequencer that numbers frames and
 * de-duplicates by `(from, id)` the way B041 does, the plan limits of the entitlement fixtures, a
 * registry over the in-memory store with a fake clock and an in-memory Redis for the rate limit,
 * and members of each role.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import type {
  AgentFrame,
  AgentSender,
  EntitlementsPort,
  SequenceStep,
} from '../../src/agents/ports.js';
import { AgentRegistry, type AgentRegistryDeps } from '../../src/agents/registry.js';
import { createStateRateLimiter } from '../../src/agents/state-rate-limit.js';
import { createMemoryAgentStore } from '../../src/agents/store.js';
import type { StoredFrame } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';

/** The fixture frame of `kind`. */
export function fixture(
  kind: 'agent.spawn' | 'agent.state' | 'agent.exit',
): Record<string, unknown> {
  const url = new URL(`../../../../contracts/fixtures/events/${kind}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { frame: Record<string, unknown> }).frame;
}

/** `max_parallel_agents` of an entitlement fixture plan. */
export function planLimit(plan: 'free' | 'pro' | 'team'): number | null {
  const url = new URL(`../../../../contracts/fixtures/entitlements/${plan}.json`, import.meta.url);
  const doc = JSON.parse(readFileSync(url, 'utf8')) as {
    data: { limits: { max_parallel_agents: number | null } };
  };
  return doc.data.limits.max_parallel_agents;
}

/** A spawn frame (fixture shape, fresh ids, `ct` kept opaque). */
export function spawn(p: {
  agent?: string;
  owner: string;
  mode?: 'command_post' | 'branch';
}): AgentFrame & {
  agentId: string;
} {
  const base = fixture('agent.spawn');
  const agentId = p.agent ?? newId('agt');
  return {
    id: newId('msg'),
    k: 'agent.spawn',
    p: {
      ...(base['p'] as Record<string, unknown>),
      agent_id: agentId,
      owner: p.owner,
      runs_on: p.owner,
      mode: p.mode ?? 'command_post',
    },
    agentId,
  };
}

/** A state frame. */
export function state(
  agentId: string,
  name: string,
  since = '2026-10-10T12:00:00.000Z',
): AgentFrame {
  return { id: newId('msg'), k: 'agent.state', p: { agent_id: agentId, state: name, since } };
}

/** An exit frame. */
export function exit(
  agentId: string,
  outcome: 'ok' | 'error' | 'canceled' = 'ok',
  errorCode?: string,
): AgentFrame {
  return {
    id: newId('msg'),
    k: 'agent.exit',
    p: {
      agent_id: agentId,
      outcome,
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
    },
  };
}

/** Sequences frames for one session like B041: numbered, a resend keeps its first seq. */
export function sequencer(clock: { now: number }) {
  const seen = new Map<string, number>();
  const sequenced: { frame: AgentFrame; seq: number; from: string }[] = [];
  let head = 0;
  let refuse = false;
  return {
    sequenced,
    /** Makes the next steps refuse (B041 answered rate_limited or unavailable). */
    set refusing(v: boolean) {
      refuse = v;
    },
    step(frame: AgentFrame, from: string): SequenceStep {
      return () => {
        if (refuse) return Promise.resolve(undefined);
        const key = `${from}:${frame.id}`;
        const prior = seen.get(key);
        const seq = prior ?? ++head;
        if (prior === undefined) {
          seen.set(key, seq);
          sequenced.push({ frame, seq, from });
        }
        const stored: StoredFrame = {
          v: 1,
          t: 'event',
          id: frame.id,
          sid: 'ses_x',
          from,
          ts: new Date(clock.now).toISOString(),
          k: frame.k,
          seq,
          p: frame.p,
        } as unknown as StoredFrame;
        return Promise.resolve(stored);
      };
    },
  };
}

/** A registry over memory, with the pro plan's limit, a host, two editors and a viewer. */
export function agentEnv(
  opts: {
    limit?: number | null;
    /** The session's mode (default command_post, as every session on main). */
    mode?: 'command_post' | 'branch';
    overrides?: Partial<AgentRegistryDeps>;
  } = {},
) {
  const clock = { now: Date.parse('2026-10-10T12:00:00.000Z') };
  const store = createMemoryAgentStore();
  const redis = createMemoryRedis(() => clock.now);
  const captured = captureLogger();
  const recorded = recordingMetrics();
  const limit = { value: opts.limit === undefined ? planLimit('pro') : opts.limit, fail: false };
  const entitlements: EntitlementsPort = {
    maxParallelAgents: () =>
      limit.fail ? Promise.reject(new Error('postgres down')) : Promise.resolve(limit.value),
  };
  const registry = new AgentRegistry({
    store,
    entitlements,
    rateLimit: createStateRateLimiter({ store: redis.rateLimit, clock: () => clock.now }),
    sessions: { modeOf: () => Promise.resolve(opts.mode ?? 'command_post') },
    logger: captured.logger,
    metrics: recorded.metrics,
    ...opts.overrides,
  });
  const seq = sequencer(clock);
  const sid = newId('ses');
  const host: AgentSender = { memberId: newId('mem'), role: 'host' };
  const editor: AgentSender = { memberId: newId('mem'), role: 'editor' };
  const other: AgentSender = { memberId: newId('mem'), role: 'editor' };
  const viewer: AgentSender = { memberId: newId('mem'), role: 'viewer' };
  const send = (frame: AgentFrame, by: AgentSender, session = sid) => {
    const step = seq.step(frame, by.memberId);
    if (frame.k === 'agent.spawn') return registry.onSpawn(session, frame, by, step);
    if (frame.k === 'agent.state') return registry.onState(session, frame, by, step);
    return registry.onExit(session, frame, by, step);
  };
  return {
    clock,
    store,
    redis,
    captured,
    recorded,
    limit,
    registry,
    seq,
    sid,
    host,
    editor,
    other,
    viewer,
    send,
  };
}
