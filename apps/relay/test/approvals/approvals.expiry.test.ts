/**
 * B060 expiry (acceptance 5, 8; failure modes 1 and 3; guardrails: the only server decision is a
 * deny on expiry, exactly once):
 *
 * - `expires_at` in the past, or more than 24 h ahead (CT-WS-SESSION-EVENTS "Limits"), is
 *   `invalid_frame`.
 * - At `expires_at` (fake clock) one server deny `{decision:'deny', scope:'once'}` goes out, once,
 *   even with two sweepers (two routers over one Redis), and the approval is gone.
 * - A decision after `expires_at` but before the sweep is refused `gone`; the sweep denies after.
 *   A decision made before expiry means no deny.
 * - A deny that cannot be sequenced is tried again by the next sweep (still once).
 * - Pending approvals survive a restart: a new router over the same Redis denies them at their
 *   original `expires_at` once it watches the session.
 * - The host being away changes nothing: the deny still goes out.
 */
import { describe, expect, it } from 'vitest';
import { ApprovalRouter } from '../../src/approvals/router.js';
import { approvalEnv, decisionFrame, inTenMinutes, requestFrame } from './helpers.js';

describe('expires_at bounds (acceptance 5)', () => {
  it('refuses a past expiry and one more than 24 h ahead; accepts exactly 24 h', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const now = env.clock.now;
    for (const expiresAt of [
      now - 1,
      now,
      now + 24 * 3_600_000 + 1,
      'not a date',
      // Date.parse would take this; the schema's date-time does not.
      `${new Date(now + 60_000).toUTCString()} (rm -rf /srv)`,
    ]) {
      expect(await env.request(requestFrame({ agent, expiresAt }), env.host)).toMatchObject({
        outcome: 'refused',
        code: 'invalid_frame',
      });
    }
    expect(
      await env.request(requestFrame({ agent, expiresAt: now + 24 * 3_600_000 }), env.host),
    ).toEqual({ outcome: 'sequenced' });
    expect(env.sequenced).toHaveLength(1);
  });
});

describe('the timeout deny (acceptance 5)', () => {
  it('at expires_at one deny goes out, once, even with two sweepers', async () => {
    const env = approvalEnv();
    const second = new ApprovalRouter(env.deps);
    second.watch(env.sid);
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    await env.request(req, env.host);
    env.clock.now += 4_999;
    expect(await env.router.sweep(new Date(env.clock.now))).toBe(0);
    env.clock.now += 1;
    const [a, b] = await Promise.all([
      env.router.sweep(new Date(env.clock.now)),
      second.sweep(new Date(env.clock.now)),
    ]);
    expect(a + b).toBe(1);
    expect(env.timeouts).toEqual([{ sid: env.sid, approvalId: req.approvalId }]);
    expect(env.recorded.count('relay_approval_timeouts_total')).toBe(1);
    // Later sweeps find nothing; the approval is gone.
    env.clock.now += 1_000;
    await env.router.sweep(new Date(env.clock.now));
    await second.sweep(new Date(env.clock.now));
    expect(env.timeouts).toHaveLength(1);
    expect(await env.deps.store.list(env.sid)).toEqual([]);
    expect(env.router.pendingCount()).toBe(0);
  });

  it('the server deny is approval.decision {decision: deny, scope: once} from srv (module)', async () => {
    // The module's emitter: checked in approvals.module.test.ts against B044's emitServer.
    const { default: relayModule } = await import('../../src/approvals/module.js');
    expect(relayModule.name).toBe('approvals');
  });

  it('a decision after expires_at, before the sweep, is refused gone; the sweep denies after', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    await env.request(req, env.host);
    env.clock.now += 5_000;
    expect(await env.decide(decisionFrame(req.approvalId), env.host)).toMatchObject({
      code: 'gone',
    });
    await env.router.sweep(new Date(env.clock.now));
    expect(env.timeouts).toHaveLength(1);
    // After the deny, a decision finds it decided.
    expect(await env.decide(decisionFrame(req.approvalId), env.host)).toMatchObject({
      code: 'forbidden',
    });
  });

  it('a decision whose tidy-up failed is never followed by a deny, even after its keys expire', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    await env.request(req, env.host);
    // The list cannot be changed after the decision is sequenced (its mutex is held elsewhere).
    const realRemove = env.deps.store.remove.bind(env.deps.store);
    let failRemove = true;
    env.deps.store.remove = (sid, ids) =>
      failRemove ? Promise.reject(new Error('mutex busy')) : realRemove(sid, ids);
    expect(await env.decide(decisionFrame(req.approvalId), env.host)).toEqual({
      outcome: 'sequenced',
    });
    failRemove = false;
    expect(await env.deps.store.list(env.sid)).toHaveLength(1);
    // Past expiry, past the pending key's TTL, past an hour: never a deny; the entry is tidied.
    for (const later of [5_000, 65_001, 3_600_000]) {
      await env.router.sweep(new Date(env.clock.now + later));
    }
    expect(env.timeouts).toEqual([]);
    expect(await env.deps.store.list(env.sid)).toEqual([]);
    expect(env.sequenced).toHaveLength(2);
  });

  it('a deny whose tidy-up failed is not sent twice', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    await env.request(req, env.host);
    const realRemove = env.deps.store.remove.bind(env.deps.store);
    let failRemove = true;
    env.deps.store.remove = (sid, ids) =>
      failRemove ? Promise.reject(new Error('mutex busy')) : realRemove(sid, ids);
    env.clock.now += 5_000;
    await env.router.sweep(new Date(env.clock.now));
    failRemove = false;
    for (const later of [1_000, 61_000, 3_600_000]) {
      await env.router.sweep(new Date(env.clock.now + later));
    }
    expect(env.timeouts).toHaveLength(1);
  });

  it('an expired request resent is acked again, not refused', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    await env.request(req, env.host);
    env.clock.now += 5_000;
    await env.router.sweep(new Date(env.clock.now));
    expect(await env.request(req, env.host)).toEqual({ outcome: 'duplicate' });
    expect(env.reacked).toHaveLength(1);
  });

  it('a decided approval id cannot be requested again', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    await env.request(req, env.host);
    await env.decide(decisionFrame(req.approvalId), env.host);
    const again = requestFrame({
      agent,
      approval: req.approvalId,
      expiresAt: inTenMinutes(env.clock.now),
    });
    expect(await env.request(again, env.host)).toMatchObject({ code: 'invalid_frame' });
    expect(env.notified).toHaveLength(1);
  });

  it('a decision before expiry means no deny', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    await env.request(req, env.host);
    env.clock.now += 4_000;
    await env.decide(decisionFrame(req.approvalId, 'deny'), env.host);
    env.clock.now += 2_000;
    expect(await env.router.sweep(new Date(env.clock.now))).toBe(0);
    expect(env.timeouts).toEqual([]);
  });

  it('a deny that cannot be sequenced is tried again by the next sweep, and goes out once', async () => {
    let fail = true;
    const sent: string[] = [];
    const env = approvalEnv({
      emitter: {
        emitTimeout(_sid, approvalId) {
          if (fail) return Promise.reject(new Error('fan-out down'));
          sent.push(approvalId);
          return Promise.resolve();
        },
      },
    });
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    await env.request(req, env.host);
    env.clock.now += 5_000;
    expect(await env.router.sweep(new Date(env.clock.now))).toBe(0);
    expect(env.recorded.count('relay_approval_emit_failures_total')).toBe(1);
    fail = false;
    expect(await env.router.sweep(new Date(env.clock.now + 1_000))).toBe(1);
    expect(await env.router.sweep(new Date(env.clock.now + 2_000))).toBe(0);
    expect(sent).toEqual([req.approvalId]);
  });

  it('the host being away changes nothing: the deny still goes out (failure mode 3)', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.editor);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    // The host has no connection: nothing about the request needs one.
    expect(await env.request(req, env.editor)).toEqual({ outcome: 'sequenced' });
    expect(env.notified).toHaveLength(1);
    env.clock.now += 5_000;
    await env.router.sweep(new Date(env.clock.now));
    expect(env.timeouts).toHaveLength(1);
  });
});

describe('restart (acceptance 8)', () => {
  it('a new router over the same Redis denies at the original expires_at once it watches', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const req = requestFrame({ agent, expiresAt: env.clock.now + 60_000 });
    await env.request(req, env.host);
    const timeouts: string[] = [];
    const restarted = new ApprovalRouter({
      ...env.deps,
      emitter: {
        emitTimeout: (_sid, approvalId) => (timeouts.push(approvalId), Promise.resolve()),
      },
    });
    restarted.watch(env.sid);
    env.clock.now += 59_999;
    expect(await restarted.sweep(new Date(env.clock.now))).toBe(0);
    expect(restarted.pendingCount()).toBe(1);
    env.clock.now += 1;
    expect(await restarted.sweep(new Date(env.clock.now))).toBe(1);
    expect(timeouts).toEqual([req.approvalId]);
  });

  it('stops watching a session with nothing pending and no room here', async () => {
    const env = approvalEnv();
    await env.router.sweep(new Date(env.clock.now), () => false);
    const agent = env.agentOf(env.host);
    // Not watched any more: its expiry is not swept here until a member joins again.
    await env.request(requestFrame({ agent, expiresAt: env.clock.now + 5_000 }), env.host);
    env.clock.now += 5_000;
    expect(await env.router.sweep(new Date(env.clock.now))).toBe(0);
    env.router.watch(env.sid);
    expect(await env.router.sweep(new Date(env.clock.now))).toBe(1);
  });
});
