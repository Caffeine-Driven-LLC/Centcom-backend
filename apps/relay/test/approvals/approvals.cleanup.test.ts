/**
 * B060 cleanup and the stage (acceptance 6; scope_in: mute and kick of a requester, agent.exit):
 * once an `agent.exit` is sequenced, that agent's pending approvals are dropped; once a
 * `control.kick` or `control.mute` is, those the member requested. None of them gets a timeout
 * deny later. Approval frames go through the router with the pipeline as their sequencing step,
 * and a refusal goes back to the sender as `sys.error` (ref = the frame id); other frames pass.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import type { ApprovalSender } from '../../src/approvals/ports.js';
import { approvalStage } from '../../src/approvals/stage.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';
import { SEQUENCED_STATE_KEY } from '../../src/seq/types.js';
import { approvalEnv, decisionFrame, inTenMinutes, requestFrame } from './helpers.js';

/** Runs `frame` through the stage as `member`; the pipeline after it sequences unless `refuse`. */
async function throughStage(
  env: ReturnType<typeof approvalEnv>,
  frame: Record<string, unknown>,
  member: ApprovalSender,
  refuse = false,
) {
  const stage = approvalStage({
    router: env.router,
    rooms: {
      locate: () =>
        ({
          room: { sid: env.sid },
          member: { id: member.memberId, role: member.role, sid: env.sid },
        }) as never,
    },
  });
  const sent: Record<string, unknown>[] = [];
  let passed = 0;
  const fc: FrameContext = {
    connection: {
      send: (f: Record<string, unknown>) => (sent.push(f), true),
    } as unknown as RelayConnection,
    raw: null,
    frame,
    state: {},
  };
  await stage(fc, () => {
    passed += 1;
    if (!refuse) fc.state[SEQUENCED_STATE_KEY] = { ...frame, seq: 1 };
    return Promise.resolve();
  });
  return { sent, passed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Three pending approvals: two for `agent` (asked by its owner), one for another agent. */
async function threePending(env: ReturnType<typeof approvalEnv>) {
  const agent = env.agentOf(env.editor);
  const otherAgent = env.agentOf(env.other);
  const exp = env.clock.now + 5_000;
  await env.request(requestFrame({ agent, expiresAt: exp }), env.editor);
  await env.request(requestFrame({ agent, expiresAt: exp }), env.editor);
  await env.request(requestFrame({ agent: otherAgent, expiresAt: exp }), env.other);
  return { agent, otherAgent };
}

describe('cleanup (acceptance 6)', () => {
  it('agent.exit drops that agent’s pending approvals, with no timeout deny', async () => {
    const env = approvalEnv();
    const { agent, otherAgent } = await threePending(env);
    await throughStage(
      env,
      {
        v: 1,
        t: 'event',
        id: newId('msg'),
        k: 'agent.exit',
        p: { agent_id: agent, outcome: 'ok' },
      },
      env.editor,
    );
    await settle();
    expect((await env.deps.store.list(env.sid)).map((a) => a.agentId)).toEqual([otherAgent]);
    env.clock.now += 5_000;
    await env.router.sweep(new Date(env.clock.now));
    expect(env.timeouts).toHaveLength(1);
  });

  it.each(['control.kick', 'control.mute'] as const)(
    '%s of the requester drops their pending approvals, with no timeout deny',
    async (k) => {
      const env = approvalEnv();
      const { otherAgent } = await threePending(env);
      await throughStage(
        env,
        {
          v: 1,
          t: 'control',
          id: newId('msg'),
          k,
          p:
            k === 'control.kick'
              ? { member: env.editor.memberId }
              : { member: env.editor.memberId, until: null },
        },
        env.host,
      );
      await settle();
      expect((await env.deps.store.list(env.sid)).map((a) => a.agentId)).toEqual([otherAgent]);
      env.clock.now += 5_000;
      await env.router.sweep(new Date(env.clock.now));
      expect(env.timeouts).toHaveLength(1);
      // A decision on a dropped approval finds nothing.
      expect(env.sequenced).toHaveLength(3);
    },
  );

  it('nothing is dropped when the exit or kick was not sequenced', async () => {
    const env = approvalEnv();
    const { agent } = await threePending(env);
    await throughStage(
      env,
      {
        v: 1,
        t: 'event',
        id: newId('msg'),
        k: 'agent.exit',
        p: { agent_id: agent, outcome: 'ok' },
      },
      env.editor,
      true,
    );
    await settle();
    expect(await env.deps.store.list(env.sid)).toHaveLength(3);
  });
});

describe('the stage', () => {
  it('routes approval frames, answers refusals with sys.error, and passes other frames', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    const ok = await throughStage(
      env,
      { v: 1, t: 'event', id: req.id, k: 'approval.request', p: req.p, ct: { c: 'opaque' } },
      env.host,
    );
    expect(ok).toEqual({ sent: [], passed: 1 });
    expect(env.notified).toHaveLength(1);
    const bad = decisionFrame(req.approvalId);
    const refused = await throughStage(
      env,
      { v: 1, t: 'event', id: bad.id, k: 'approval.decision', p: bad.p },
      env.editor,
    );
    expect(refused.passed).toBe(0);
    expect(refused.sent).toHaveLength(1);
    expect(refused.sent[0]).toMatchObject({
      t: 'sys.error',
      ref: bad.id,
      p: { code: 'forbidden' },
    });
    const other = await throughStage(
      env,
      { v: 1, t: 'event', id: newId('msg'), k: 'message.user', ct: { c: 'x' } },
      env.editor,
    );
    expect(other).toEqual({ sent: [], passed: 1 });
  });

  it('Redis down: service_unavailable with retry_after_s, nothing sequenced', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    env.down.on = true;
    const out = await throughStage(
      env,
      { v: 1, t: 'event', id: req.id, k: 'approval.request', p: req.p },
      env.host,
    );
    expect(out.passed).toBe(0);
    expect(out.sent[0]).toMatchObject({
      t: 'sys.error',
      ref: req.id,
      p: { code: 'service_unavailable', retry_after_s: 1 },
    });
    expect(env.notified).toEqual([]);
  });
});
