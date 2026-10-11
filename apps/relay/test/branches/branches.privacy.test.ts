/**
 * B061 privacy (acceptance 7; guardrails: never decrypt, parse or store `ct`; signals carry agent
 * ids and path hashes only): after branch updates, member and server conflict signals, refusals
 * and failures, no log line and no Redis key or value holds the `ct`, a path hash or an agent id;
 * Redis holds only hashed window keys, the marking member/frame or `srv`, and the rate limiter's
 * per-session key (every `kv` write and every limiter key is recorded).
 */
import { describe, expect, it } from 'vitest';
import { branchUpdate, conflict, signalEnv } from './helpers.js';

describe('privacy (acceptance 7)', () => {
  it('logs and stores no ct, path hash or agent id', async () => {
    const env = signalEnv();
    const [a, b] = [env.agentOf(env.host), env.agentOf(env.editor)];
    const secretCt = { alg: 'xchacha20poly1305', kid: 'k1', n: 'N'.repeat(32), c: 'SECRETCIPHER' };
    await env.send(branchUpdate({ ct: secretCt }), env.host);
    await env.send(conflict([a, b], ['PathHashOne', 'PathHashTwo']), env.host);
    await env.send(conflict([a, b], ['PathHashOne', 'PathHashTwo']), env.host);
    await env.conflicts.onLockDenied(env.sid, {
      holderAgent: a,
      requesterAgent: b,
      pathHmac: 'PathHashThree',
    });
    env.down.on = true;
    await env.send(conflict([a], ['PathHashFour']), env.host);
    await env.conflicts.onLockDenied(env.sid, {
      holderAgent: b,
      requesterAgent: a,
      pathHmac: 'PathHashFive',
    });
    const secrets = ['SECRETCIPHER', 'PathHash', a, b];
    const logs = env.captured.raw();
    for (const s of secrets) expect(logs).not.toContain(s);
    expect(env.written.length).toBeGreaterThan(0);
    for (const { key, value } of env.written) {
      for (const s of secrets) {
        expect(key).not.toContain(s);
        expect(value).not.toContain(s);
      }
      expect(key).toMatch(
        /^(conflict:ses_[0-9A-Z]{26}:(pair:)?[A-Za-z0-9_-]{22}|conflict-signals:ses_[0-9A-Z]{26})$/,
      );
    }
  });
});
