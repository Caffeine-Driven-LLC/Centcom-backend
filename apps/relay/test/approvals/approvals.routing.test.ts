/**
 * B060 routing (acceptance 1-3, 7): who may ask and who may decide.
 *
 * - A request from the host, or from the agent's owner, is sequenced and stored; anyone else's is
 *   `forbidden`.
 * - The approver matrix: `host` -> only the host; `any_editor` -> any editor; `owner` -> workspace
 *   owner or admin members only. The host always may; members in `control.policy.approvers` may
 *   (CT-WS-SESSION-EVENTS "Who may send `approval.decision`"). A refused decider gets `forbidden`
 *   and one `permission.denied` audit event.
 * - Viewers never decide; a requester cannot approve their own request unless they are the host.
 * - `scope` (once, session, always) is forwarded as it is, and nothing is remembered: the next
 *   request needs its own decision.
 */
import { describe, expect, it } from 'vitest';
import { approvalEnv, decisionFrame, inTenMinutes, requestFrame } from './helpers.js';

describe('requests (acceptance 1)', () => {
  it('the host and the agent owner may ask; another editor may not', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.editor);
    const exp = inTenMinutes(env.clock.now);
    expect(await env.request(requestFrame({ agent, expiresAt: exp }), env.host)).toEqual({
      outcome: 'sequenced',
    });
    expect(await env.request(requestFrame({ agent, expiresAt: exp }), env.editor)).toEqual({
      outcome: 'sequenced',
    });
    expect(await env.request(requestFrame({ agent, expiresAt: exp }), env.other)).toMatchObject({
      outcome: 'refused',
      code: 'forbidden',
    });
    // An agent the session does not know: only the host may ask about it.
    const unknown = requestFrame({ agent: 'agt_01JA3Z8K2M5N7P9Q0R1S2T3V4W', expiresAt: exp });
    expect(await env.request(unknown, env.editor)).toMatchObject({ code: 'forbidden' });
    expect(env.sequenced).toHaveLength(2);
    expect(await env.deps.store.list(env.sid)).toHaveLength(2);
  });

  it('stores ids, enums and times only, with its seq', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const frame = requestFrame({
      agent,
      risk: 'high',
      approver: 'owner',
      expiresAt: inTenMinutes(env.clock.now),
    });
    await env.request(frame, env.host);
    const [stored] = await env.deps.store.list(env.sid);
    expect(stored).toEqual({
      approvalId: frame.approvalId,
      agentId: agent,
      requester: env.host.memberId,
      risk: 'high',
      approver: 'owner',
      expiresAt: (frame.p as { expires_at: string }).expires_at,
      requestedAt: env.clock.now,
      requestSeq: 1,
      frameId: frame.id,
    });
  });

  it('refuses a second request with the same approval_id', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const first = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(first, env.host);
    const again = requestFrame({
      agent,
      approval: first.approvalId,
      expiresAt: inTenMinutes(env.clock.now),
    });
    expect(await env.request(again, env.host)).toMatchObject({ code: 'invalid_frame' });
  });
});

describe('the approver matrix (acceptance 2)', () => {
  /** Whether `who` may decide a request naming `approver`, asked by the host. */
  async function may(
    approver: 'host' | 'owner' | 'any_editor',
    who: 'host' | 'editor' | 'admin' | 'owner',
  ): Promise<string> {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, approver, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    const result = await env.decide(decisionFrame(req.approvalId), env[who]);
    if (result.outcome === 'refused') {
      expect(env.audited).toHaveLength(1);
      expect(env.audited[0]).toMatchObject({
        action: 'permission.denied',
        outcome: 'denied',
        meta: { attempted: 'approval.decision', reason: 'approver' },
      });
      return result.code;
    }
    expect(env.audited).toHaveLength(0);
    return result.outcome;
  }

  it.each([
    ['host', 'host', 'sequenced'],
    ['host', 'editor', 'forbidden'],
    ['host', 'admin', 'forbidden'],
    ['host', 'owner', 'forbidden'],
    ['any_editor', 'host', 'sequenced'],
    ['any_editor', 'editor', 'sequenced'],
    ['any_editor', 'admin', 'sequenced'],
    ['owner', 'host', 'sequenced'],
    ['owner', 'editor', 'forbidden'],
    ['owner', 'admin', 'sequenced'],
    ['owner', 'owner', 'sequenced'],
  ] as const)('approver %s, decided by %s: %s', async (approver, who, expected) => {
    expect(await may(approver, who)).toBe(expected);
  });

  it('a member in control.policy.approvers may decide even when approver is host', async () => {
    const env = approvalEnv();
    env.approvers.push(env.other.memberId);
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, approver: 'host', expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    expect(await env.decide(decisionFrame(req.approvalId), env.other)).toEqual({
      outcome: 'sequenced',
    });
  });

  it('a member who left (no live membership) may not decide', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({
      agent,
      approver: 'any_editor',
      expiresAt: inTenMinutes(env.clock.now),
    });
    await env.request(req, env.host);
    env.members.delete(env.editor.memberId);
    expect(await env.decide(decisionFrame(req.approvalId), env.editor)).toMatchObject({
      code: 'forbidden',
    });
  });

  it('roles are the live ones: a demoted host is judged as what they are now', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, approver: 'host', expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    // The frame's sender still says host (the connection's view); the records say editor now.
    const live = env.members.get(env.host.memberId);
    if (live !== undefined) live.role = 'editor';
    expect(
      await env.router.onDecision(
        {
          sid: env.sid,
          sender: { memberId: env.host.memberId, role: 'host' },
          sequence: () => Promise.resolve(undefined),
        },
        decisionFrame(req.approvalId),
      ),
    ).toMatchObject({ code: 'forbidden' });
  });
});

describe('viewers and self-approval (acceptance 3)', () => {
  it('a viewer never decides, whatever the approver or the policy says', async () => {
    const env = approvalEnv();
    env.approvers.push(env.viewer.memberId);
    const agent = env.agentOf(env.host);
    const req = requestFrame({
      agent,
      approver: 'any_editor',
      expiresAt: inTenMinutes(env.clock.now),
    });
    await env.request(req, env.host);
    expect(await env.decide(decisionFrame(req.approvalId), env.viewer)).toMatchObject({
      code: 'forbidden',
    });
  });

  it('a requester cannot approve their own request, even as a policy approver', async () => {
    const env = approvalEnv();
    env.approvers.push(env.editor.memberId);
    const agent = env.agentOf(env.editor);
    const req = requestFrame({
      agent,
      approver: 'any_editor',
      expiresAt: inTenMinutes(env.clock.now),
    });
    await env.request(req, env.editor);
    expect(await env.decide(decisionFrame(req.approvalId), env.editor)).toMatchObject({
      code: 'forbidden',
    });
    // Another editor may.
    expect(await env.decide(decisionFrame(req.approvalId), env.other)).toEqual({
      outcome: 'sequenced',
    });
  });

  it('the host may approve their own request', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    expect(await env.decide(decisionFrame(req.approvalId), env.host)).toEqual({
      outcome: 'sequenced',
    });
  });
});

describe('scopes (acceptance 7)', () => {
  it.each(['once', 'session', 'always'] as const)(
    'scope %s is forwarded as it is, and the next request still needs a decision',
    async (scope) => {
      const env = approvalEnv();
      const agent = env.agentOf(env.host);
      const first = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
      await env.request(first, env.host);
      const decision = decisionFrame(first.approvalId, 'approve', scope);
      await env.decide(decision, env.host);
      expect(env.sequenced.at(-1)?.frame.p).toEqual({
        approval_id: first.approvalId,
        decision: 'approve',
        scope,
      });
      const second = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
      expect(await env.request(second, env.host)).toEqual({ outcome: 'sequenced' });
      // Nothing answered it: it is pending, and only a sweep at its expiry would deny it.
      expect((await env.deps.store.list(env.sid)).map((a) => a.approvalId)).toEqual([
        second.approvalId,
      ]);
      expect(env.sequenced).toHaveLength(3);
      expect(env.timeouts).toHaveLength(0);
    },
  );

  it('an unknown approval id is not_found; a malformed decision is invalid_frame', async () => {
    const env = approvalEnv();
    expect(
      await env.decide(decisionFrame('apr_01JA3Z8K2M5N7P9Q0R1S2T3V4W'), env.host),
    ).toMatchObject({ code: 'not_found' });
    expect(
      await env.decide(
        { id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W', p: { approval_id: 'x', decision: 'maybe' } },
        env.host,
      ),
    ).toMatchObject({ code: 'invalid_frame' });
  });
});
