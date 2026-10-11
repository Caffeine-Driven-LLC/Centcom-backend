/**
 * B060 notifications (acceptance 1; failure mode 2; guardrails: ids and enums only):
 * `NotifyPort.approvalNeeded` is called exactly once per approval id even when the request frame is
 * resent, with the approval, agent and risk only; a request whose sequencing is refused notifies
 * nobody (its resend then does, once); a failing port never stops the request (counted).
 */
import { describe, expect, it } from 'vitest';
import { approvalEnv, decisionFrame, inTenMinutes, requestFrame } from './helpers.js';

describe('exactly-once notification (acceptance 1)', () => {
  it('a resent request is acked again and notifies nobody a second time', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, risk: 'high', expiresAt: inTenMinutes(env.clock.now) });
    expect(await env.request(req, env.host)).toEqual({ outcome: 'sequenced' });
    expect(await env.request(req, env.host)).toEqual({ outcome: 'duplicate' });
    expect(await env.request(req, env.host)).toEqual({ outcome: 'duplicate' });
    expect(env.sequenced).toHaveLength(1);
    expect(env.notified).toEqual([
      {
        sid: env.sid,
        approvalId: req.approvalId,
        agentId: agent,
        risk: 'high',
        approver: 'host',
        requester: env.host.memberId,
      },
    ]);
    // The resends after the first was sequenced were acked again by the sequencer.
    expect(env.reacked).toHaveLength(2);
  });

  it('resends racing the first one: stored, sequenced and notified once (B041 drops duplicates)', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    const results = await Promise.all([1, 2, 3].map(() => env.request(req, env.host)));
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'duplicate', 'sequenced']);
    expect(env.notified).toHaveLength(1);
    expect(env.sequenced).toHaveLength(1);
    expect((await env.deps.store.list(env.sid)).map((a) => a.approvalId)).toEqual([req.approvalId]);
  });

  it('a request stored but whose outcome was lost counts once its resend learns it', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.editor);
    const req = requestFrame({
      agent,
      approver: 'any_editor',
      expiresAt: inTenMinutes(env.clock.now),
    });
    env.loseOutcome.add(req.id);
    // B041 refused it after the store failed: the record stays (it may be in the log).
    expect(await env.request(req, env.editor)).toEqual({ outcome: 'ignored' });
    expect(env.notified).toHaveLength(0);
    expect(env.sequenced).toHaveLength(1);
    // The client's retry a second later (the original is no longer on its way): the sequencer
    // says it was stored, so the request counts, notified once, decidable.
    env.clock.now += 1_000;
    expect(await env.request(req, env.editor)).toEqual({ outcome: 'duplicate' });
    expect(env.reacked).toHaveLength(1);
    expect(env.notified).toHaveLength(1);
    expect((await env.deps.store.get(env.sid, req.approvalId))?.requestSeq).toBe(1);
    expect(await env.decide(decisionFrame(req.approvalId), env.other)).toEqual({
      outcome: 'sequenced',
    });
    expect(env.sequenced).toHaveLength(2);
  });

  it('a resent request must repeat the original', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.editor);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    env.failUnknown.add(req.id);
    expect(await env.request(req, env.editor)).toEqual({ outcome: 'ignored' });
    const other = env.agentOf(env.other);
    const changed = { id: req.id, p: { ...(req.p as Record<string, unknown>), agent_id: other } };
    expect(await env.request(changed, env.editor)).toMatchObject({ code: 'invalid_frame' });
    expect(await env.request(req, env.editor)).toEqual({ outcome: 'duplicate' });
    expect(env.sequenced).toHaveLength(1);
    expect(env.notified).toHaveLength(1);
  });

  it('a request resent after it was decided is acked again, not refused', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    await env.decide(decisionFrame(req.approvalId), env.host);
    expect(await env.request(req, env.host)).toEqual({ outcome: 'duplicate' });
    expect(env.reacked).toHaveLength(1);
    expect(env.notified).toHaveLength(1);
  });

  it('a request sequencing refused notifies nobody, and its resend notifies once', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    const refused = await env.router.onRequest(
      { sid: env.sid, sender: env.host, sequence: () => Promise.resolve(undefined) },
      req,
    );
    expect(refused).toEqual({ outcome: 'ignored' });
    expect(env.notified).toEqual([]);
    expect(await env.deps.store.list(env.sid)).toEqual([]);
    expect(await env.request(req, env.host)).toEqual({ outcome: 'sequenced' });
    expect(env.notified).toHaveLength(1);
  });
});

describe('a failing dispatcher (failure mode 2)', () => {
  it('the request is still routed; the failure is counted', async () => {
    const env = approvalEnv({
      notify: {
        approvalNeeded() {
          throw new Error('dispatcher down');
        },
      },
    });
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    expect(await env.request(req, env.host)).toEqual({ outcome: 'sequenced' });
    expect(env.recorded.count('relay_approval_notify_failures_total')).toBe(1);
    expect(await env.deps.store.list(env.sid)).toHaveLength(1);
  });
});
