/**
 * B060 privacy (guardrails: never read summary, command or cwd; notifications carry ids and enums
 * only): even when a client puts secret fields in the cleartext `p`, every Redis key and value
 * written during a request, a decision, a timeout and a cleanup holds only allow-listed fields and
 * none of the secrets; notifications carry the approval, agent and risk only; logs carry none of
 * the secrets.
 */
import { describe, expect, it } from 'vitest';
import { approvalEnv, decisionFrame, inTenMinutes, requestFrame } from './helpers.js';

const SECRETS = ['rm -rf /srv/billing', '/home/alex/work/secret-repo', 'Deploy the billing fix'];

describe('approval privacy', () => {
  it('stores and notifies ids and enums only, never ct-derived data', async () => {
    const env = approvalEnv();
    const agent = env.agentOf(env.host);
    const leaky = requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) });
    // A misbehaving client puts the secret fields in the clear part.
    Object.assign(leaky.p as Record<string, unknown>, {
      command: SECRETS[0],
      cwd: SECRETS[1],
      summary: SECRETS[2],
    });
    await env.request(leaky, env.host);
    const decided = decisionFrame(leaky.approvalId);
    (decided.p as Record<string, unknown>)['reason'] = SECRETS[2];
    await env.decide(decided, env.host);
    const timed = requestFrame({ agent, expiresAt: env.clock.now + 5_000 });
    Object.assign(timed.p as Record<string, unknown>, { command: SECRETS[0] });
    await env.request(timed, env.host);
    env.clock.now += 5_000;
    await env.router.sweep(new Date(env.clock.now));
    await env.request(requestFrame({ agent, expiresAt: inTenMinutes(env.clock.now) }), env.host);
    await env.router.cancelForAgent(env.sid, agent);

    const allowed = new Set([
      'approvalId',
      'agentId',
      'requester',
      'risk',
      'approver',
      'expiresAt',
      'requestedAt',
      'requestSeq',
      'frameId',
      'by',
      'frame',
      'seq',
      'at',
      'req',
      'exp',
    ]);
    expect(env.written.length).toBeGreaterThan(0);
    for (const { key, value } of env.written) {
      expect(key).toMatch(
        /^(approval:ses_[0-9A-Z]{26}:apr_[0-9A-Z]{26}(:decided)?|approvals:ses_[0-9A-Z]{26}(:mutex)?)$/,
      );
      for (const secret of SECRETS) expect(value).not.toContain(secret);
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        continue; // the mutex token
      }
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === 'object') {
          for (const [k, child] of Object.entries(v)) {
            expect(allowed.has(k), k).toBe(true);
            walk(child);
          }
        }
      };
      walk(parsed);
    }
    for (const n of env.notified) {
      expect(Object.keys(n).sort()).toEqual([
        'agentId',
        'approvalId',
        'approver',
        'requester',
        'risk',
        'sid',
      ]);
    }
    const logs = env.captured.raw();
    for (const secret of SECRETS) expect(logs).not.toContain(secret);
    for (const event of env.audited) {
      for (const secret of SECRETS) expect(JSON.stringify(event)).not.toContain(secret);
    }
  });
});
