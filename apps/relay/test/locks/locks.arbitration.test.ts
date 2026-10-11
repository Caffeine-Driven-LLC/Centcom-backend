/**
 * B059 arbitration (acceptance 1, 3, 6; failure mode 3): concurrent acquires of one path give
 * exactly one holder, and the others a sequenced deny carrying the holder's agent id only in
 * `agent_id` (100 interleaved trials, and a property test over random interleavings); release by a
 * non-owner is ignored, by the owner frees the path and grants the first waiter in the same
 * sequencing batch; the holder's re-acquire extends the TTL without a deny; a resend replays its
 * outcome and never queues twice.
 */
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lock, lockEnv } from './helpers.js';

/** The holder of `path`, read from its lock key. */
const holderOf = async (env: ReturnType<typeof lockEnv>, path: string) => {
  const raw = await env.redis.kv.get(`lock:${env.sid}:${path}`);
  return raw === null ? undefined : (JSON.parse(raw) as { agent: string }).agent;
};

describe('acquire races (acceptance 1)', () => {
  it('100 trials of two concurrent acquires: exactly one holder, one sequenced deny naming it', async () => {
    const wins = new Set<string>();
    for (let trial = 0; trial < 100; trial++) {
      const env = lockEnv();
      const path = `p${trial}`;
      const a = newId('agt');
      const b = newId('agt');
      // Interleave differently per trial: which starts first, and how many ticks it waits.
      const delay = (n: number) => Promise.all(Array.from({ length: n }, () => Promise.resolve()));
      const [ra, rb] = await Promise.all([
        delay(trial % 3).then(() => env.send(lock('acquire', path, a), env.editor)),
        delay((trial >> 1) % 3).then(() => env.send(lock('acquire', path, b), env.other)),
      ]);
      const outcomes = [ra.outcome, rb.outcome].sort();
      expect(outcomes).toEqual(['granted', 'queued']);
      const winner = ra.outcome === 'granted' ? a : b;
      const loser = winner === a ? b : a;
      const denies = env.emitted.filter((e) => e.p['action'] === 'deny');
      expect(denies).toEqual([
        { sid: env.sid, p: { action: 'deny', path_hmac: path, agent_id: winner } },
      ]);
      expect(JSON.stringify(denies)).not.toContain(loser);
      expect(env.sequenced.filter((s) => s.from !== 'srv')).toHaveLength(1);
      expect(await holderOf(env, path)).toBe(winner);
      wins.add(winner === a ? 'a' : 'b');
    }
    expect([...wins].sort()).toEqual(['a', 'b']);
  });

  it('never grants a held path to another agent, under random interleavings (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            agent: fc.integer({ min: 0, max: 3 }),
            act: fc.constantFrom('acquire', 'release'),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (steps) => {
          const env = lockEnv();
          const agents = [0, 1, 2, 3].map(() => newId('agt'));
          const senders = [env.host, env.editor, env.other, env.host];
          await Promise.all(
            steps.map((s) =>
              env.send(lock(s.act, 'shared', agents[s.agent] ?? ''), senders[s.agent] ?? env.host),
            ),
          );
          // Replay what was sequenced, in seq order: an acquire only ever goes to a free path or
          // to its holder; a release frees it.
          let holder: string | null = null;
          for (const entry of [...env.sequenced].sort((a, b) => a.seq - b.seq)) {
            const p = entry.frame['p'] as { action: string; agent_id: string };
            if (p.action === 'acquire') {
              if (holder !== null && holder !== p.agent_id) return false;
              holder = p.agent_id;
            } else if (p.action === 'release') {
              if (holder !== p.agent_id) return false;
              holder = null;
            }
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('release (acceptance 3)', () => {
  it('a non-owner release is ignored; the owner release grants the first waiter in the same batch', async () => {
    const env = lockEnv();
    const a = newId('agt');
    const b = newId('agt');
    const c = newId('agt');
    await env.send(lock('acquire', 'x', a), env.editor);
    expect(await env.send(lock('acquire', 'x', b), env.other)).toEqual({
      outcome: 'queued',
      position: 1,
    });
    expect(await env.send(lock('acquire', 'x', c), env.host)).toEqual({
      outcome: 'queued',
      position: 2,
    });
    expect(await env.send(lock('release', 'x', a), env.other)).toEqual({ outcome: 'ignored' });
    expect(await env.send(lock('release', 'x', b), env.other)).toEqual({ outcome: 'ignored' });
    const before = env.sequenced.length;
    expect(await env.send(lock('release', 'x', a), env.editor)).toEqual({ outcome: 'released' });
    const batch = env.sequenced.slice(before);
    expect(batch.map((s) => [s.from === 'srv' ? 'srv' : 'client', s.frame['p']])).toEqual([
      ['client', { action: 'release', path_hmac: 'x', agent_id: a }],
      ['srv', { action: 'acquire', path_hmac: 'x', agent_id: b, ttl_ms: 300_000 }],
    ]);
    expect(batch[1]?.seq).toBe((batch[0]?.seq ?? 0) + 1);
    // c is next.
    await env.send(lock('release', 'x', b), env.other);
    expect(env.sequenced.at(-1)?.frame['p']).toMatchObject({ action: 'acquire', agent_id: c });
  });
});

describe('re-acquire and resends (acceptance 6; failure mode 3)', () => {
  it("the holder's re-acquire extends the expiry and emits no deny", async () => {
    const env = lockEnv();
    const a = newId('agt');
    await env.send(lock('acquire', 'x', a, 10_000), env.editor);
    env.clock.now += 8_000;
    expect(await env.send(lock('acquire', 'x', a, 10_000), env.editor)).toEqual({
      outcome: 'granted',
    });
    expect(env.emitted).toEqual([]);
    env.clock.now += 8_000;
    expect(await env.service.sweep(new Date(env.clock.now))).toBe(0);
  });

  it('a resent acquire replays its outcome: same seq, no second waiter entry', async () => {
    const env = lockEnv();
    const a = newId('agt');
    const b = newId('agt');
    const first = lock('acquire', 'x', a);
    expect(await env.send(first, env.editor)).toEqual({ outcome: 'granted' });
    expect(await env.send(first, env.editor)).toEqual({ outcome: 'granted' });
    expect(env.sequenced.filter((s) => s.from !== 'srv')).toHaveLength(1);
    const wait = lock('acquire', 'x', b);
    await env.send(wait, env.other);
    await env.send(wait, env.other);
    await env.send(lock('acquire', 'x', b), env.other);
    const doc = JSON.parse((await env.redis.kv.get(`locks:${env.sid}`)) ?? '{}') as {
      queues: { waiters: unknown[] }[];
    };
    expect(doc.queues[0]?.waiters).toHaveLength(1);
  });
});
