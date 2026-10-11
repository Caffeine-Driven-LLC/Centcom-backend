/**
 * B060 races (acceptance 4; scope_in: first decision wins): two decisions on one approval, sent at
 * once in varying interleavings, sequence exactly one; the other is refused `forbidden` and changes
 * nothing. An exact resend of the winning decision is acked again (a no-op), not refused, and not
 * sequenced twice.
 */
import { describe, expect, it } from 'vitest';
import { approvalEnv, decisionFrame, inTenMinutes, requestFrame } from './helpers.js';

describe('concurrent decisions (acceptance 4)', () => {
  it('approve and deny race: one is sequenced, the other refused (100 trials)', async () => {
    const winners = new Set<string>();
    for (let trial = 0; trial < 100; trial++) {
      const env = approvalEnv();
      env.approvers.push(env.other.memberId);
      const agent = env.agentOf(env.host);
      const req = requestFrame({
        agent,
        approver: 'any_editor',
        expiresAt: inTenMinutes(env.clock.now),
      });
      await env.request(req, env.host);
      const delay = (n: number) => Promise.all(Array.from({ length: n }, () => Promise.resolve()));
      const approve = decisionFrame(req.approvalId, 'approve');
      const deny = decisionFrame(req.approvalId, 'deny');
      const [ra, rb] = await Promise.all([
        delay(trial % 4).then(() => env.decide(approve, env.editor)),
        delay((trial >> 2) % 4).then(() => env.decide(deny, env.other)),
      ]);
      const outcomes = [ra.outcome, rb.outcome].sort();
      expect(outcomes).toEqual(['refused', 'sequenced']);
      const loser = ra.outcome === 'refused' ? ra : rb;
      expect(loser).toMatchObject({ code: 'forbidden' });
      // One request and one decision were sequenced, nothing more.
      expect(env.sequenced).toHaveLength(2);
      const decided = env.sequenced[1]?.frame.p as { decision: string };
      winners.add(decided.decision);
      expect(await env.deps.store.list(env.sid)).toEqual([]);
    }
    expect([...winners].sort()).toEqual(['approve', 'deny']);
  });

  it('a decision resent while the original is on its way never frees the claim (B041 drops duplicates)', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({
      agent,
      approver: 'any_editor',
      expiresAt: inTenMinutes(env.clock.now),
    });
    await env.request(req, env.host);
    const approve = decisionFrame(req.approvalId, 'approve');
    const results = await Promise.all([1, 2, 3].map(() => env.decide(approve, env.editor)));
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'duplicate', 'sequenced']);
    // Nobody else can decide it now, and its expiry sends no deny.
    expect(await env.decide(decisionFrame(req.approvalId, 'deny'), env.other)).toMatchObject({
      code: 'forbidden',
    });
    env.clock.now += 600_000 + 60_000;
    await env.router.sweep(new Date(env.clock.now));
    expect(env.timeouts).toEqual([]);
    expect(env.sequenced).toHaveLength(2);
  });

  it('a decision stored but whose outcome was lost keeps its claim; its resend settles it', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, approver: 'any_editor', expiresAt: env.clock.now + 60_000 });
    await env.request(req, env.host);
    const approve = decisionFrame(req.approvalId, 'approve');
    env.loseOutcome.add(approve.id);
    expect(await env.decide(approve, env.editor)).toEqual({ outcome: 'ignored' });
    // The approve is in the log: nobody else may decide, and no deny follows it.
    expect(await env.decide(decisionFrame(req.approvalId, 'deny'), env.other)).toMatchObject({
      code: 'forbidden',
    });
    env.clock.now += 30_001;
    expect(await env.decide(approve, env.editor)).toEqual({ outcome: 'duplicate' });
    expect(env.reacked).toHaveLength(1);
    expect(await env.deps.store.list(env.sid)).toEqual([]);
    for (const later of [30_000, 120_000]) await env.router.sweep(new Date(env.clock.now + later));
    expect(env.timeouts).toEqual([]);
    expect(env.sequenced).toHaveLength(2);
  });

  it('a refused resend keeps the claim of a decision whose outcome is unknown', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, approver: 'any_editor', expiresAt: env.clock.now + 60_000 });
    await env.request(req, env.host);
    const approve = decisionFrame(req.approvalId, 'approve');
    env.loseOutcome.add(approve.id);
    expect(await env.decide(approve, env.editor)).toEqual({ outcome: 'ignored' });
    env.clock.now += 30_001;
    // Its resend is refused (a rate limit): that says nothing about the original.
    expect(
      await env.router.onDecision(
        { sid: env.sid, sender: env.editor, sequence: () => Promise.resolve(undefined) },
        approve,
      ),
    ).toEqual({ outcome: 'ignored' });
    expect(await env.decide(decisionFrame(req.approvalId, 'deny'), env.other)).toMatchObject({
      code: 'forbidden',
    });
    // A resend that gets through settles it.
    expect(await env.decide(approve, env.editor)).toEqual({ outcome: 'duplicate' });
    expect(env.sequenced).toHaveLength(2);
  });

  it("an unknown outcome that was not stored: the client's quick retry is sequenced, once", async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, approver: 'any_editor', expiresAt: env.clock.now + 60_000 });
    await env.request(req, env.host);
    const approve = decisionFrame(req.approvalId, 'approve');
    env.failUnknown.add(approve.id);
    expect(await env.decide(approve, env.editor)).toEqual({ outcome: 'ignored' });
    expect(env.sequenced).toHaveLength(1);
    // The retry a second later (retry_after_s 1) reaches the sequencer and is stored.
    env.clock.now += 1_000;
    expect(await env.decide(approve, env.editor)).toEqual({ outcome: 'duplicate' });
    expect(env.sequenced).toHaveLength(2);
    expect(await env.decide(decisionFrame(req.approvalId, 'deny'), env.other)).toMatchObject({
      code: 'forbidden',
    });
    await env.router.sweep(new Date(env.clock.now + 120_000));
    expect(env.timeouts).toEqual([]);
  });

  it('an unsettled decision resent after its approval expired is refused gone', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, approver: 'any_editor', expiresAt: env.clock.now + 20_000 });
    await env.request(req, env.host);
    const approve = decisionFrame(req.approvalId, 'approve');
    // Its first attempt failed before the store, in a way the router could not tell (a throw).
    const lost = await env.router.onDecision(
      { sid: env.sid, sender: env.editor, sequence: () => Promise.reject(new Error('down')) },
      approve,
    );
    expect(lost).toMatchObject({ code: 'service_unavailable' });
    env.clock.now += 30_001;
    expect(await env.decide(approve, env.editor)).toMatchObject({ code: 'gone' });
    expect(env.sequenced).toHaveLength(1);
  });

  it('an exact resend of the winning decision is acked again, not refused or doubled', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    const decision = decisionFrame(req.approvalId);
    expect(await env.decide(decision, env.host)).toEqual({ outcome: 'sequenced' });
    expect(await env.decide(decision, env.host)).toEqual({ outcome: 'duplicate' });
    expect(env.sequenced).toHaveLength(2);
    expect(env.reacked).toHaveLength(1);
    // A different frame from the same member is a later decision: refused.
    expect(await env.decide(decisionFrame(req.approvalId, 'deny'), env.host)).toMatchObject({
      code: 'forbidden',
    });
  });

  it('a decision whose sequencing is refused frees the approval for the next decider', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    const refused = await env.router.onDecision(
      { sid: env.sid, sender: env.host, sequence: () => Promise.resolve(undefined) },
      decisionFrame(req.approvalId),
    );
    expect(refused).toEqual({ outcome: 'ignored' });
    expect(await env.decide(decisionFrame(req.approvalId, 'deny'), env.host)).toEqual({
      outcome: 'sequenced',
    });
  });

  it('records the decision latency (relay_approval_decision_latency_ms)', async () => {
    const observed: number[] = [];
    const env = approvalEnv({
      metrics: {
        counter: () => ({ inc: () => undefined }),
        histogram: (name) => ({
          observe: (v: number) => {
            if (name === 'relay_approval_decision_latency_ms') observed.push(v);
          },
        }),
      },
    });
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    env.clock.now += 2_500;
    await env.decide(decisionFrame(req.approvalId), env.host);
    expect(observed).toEqual([2_500]);
  });
});
