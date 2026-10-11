/**
 * B061 conflict signals (acceptance 3-5; failure modes):
 *
 * - From a member: an unknown agent, or one whose owner is not connected, is `invalid_frame`; 201
 *   path hashes are `invalid_frame` (schema max 200), 200 pass; an identical signal (any order)
 *   within 30 s is refused `conflict`, after 30 s it passes; the same frame sent again is acked.
 * - From lock denials: the same denial twice within 30 s gives one server signal, after 30 s a
 *   second; two different pairs give two; the signal names both agents and the one path hash and
 *   nothing else; at most 10 per session per second (the rest counted and dropped); agents the
 *   session does not know or whose owner is gone are dropped (no signal with fewer than two).
 * - Registry down: a member's signal is `service_unavailable`; a server signal is dropped.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { branchUpdate, conflict, signalEnv } from './helpers.js';

describe('client conflict.detected (acceptance 3)', () => {
  it('refuses unknown agents and agents of members not connected', async () => {
    const env = signalEnv();
    const a = env.agentOf(env.host);
    const unknown = conflict([a, newId('agt')], ['h1']);
    expect((await env.send(unknown, env.host)).error).toMatchObject({
      p: { code: 'invalid_frame' },
    });
    const b = env.agentOf(env.editor);
    env.connected.delete(env.editor.memberId);
    expect((await env.send(conflict([a, b], ['h1']), env.host)).error).toMatchObject({
      p: { code: 'invalid_frame' },
    });
    env.connected.add(env.editor.memberId);
    expect((await env.send(conflict([a, b], ['h1']), env.host)).passed).toBe(true);
    expect(env.recorded.count('relay_conflicts_signalled_total', { source: 'client' })).toBe(1);
  });

  it('refuses 201 path hashes; accepts 200', async () => {
    const env = signalEnv();
    const a = env.agentOf(env.host);
    const many = (n: number) => Array.from({ length: n }, (_, i) => `h${i}`);
    expect((await env.send(conflict([a], many(201)), env.host)).error).toMatchObject({
      p: { code: 'invalid_frame' },
    });
    expect((await env.send(conflict([a], many(200)), env.host)).passed).toBe(true);
  });

  it('an identical signal within 30 s is refused conflict; after 30 s it passes; a resend is acked', async () => {
    const env = signalEnv();
    const [a, b] = [env.agentOf(env.host), env.agentOf(env.editor)];
    const first = conflict([a, b], ['x', 'y']);
    expect((await env.send(first, env.host)).passed).toBe(true);
    // The same frame again: on to the sequencer (B041 acks it), nothing new sequenced.
    expect((await env.send(first, env.host)).passed).toBe(true);
    expect(env.sequenced).toHaveLength(1);
    env.clock.now += 29_999;
    const same = conflict([b, a], ['y', 'x']);
    expect((await env.send(same, env.host)).error).toMatchObject({ p: { code: 'conflict' } });
    env.clock.now += 1;
    expect((await env.send(conflict([b, a], ['y', 'x']), env.host)).passed).toBe(true);
    // A different set is another signal.
    expect((await env.send(conflict([a, b], ['z']), env.host)).passed).toBe(true);
    expect(env.sequenced).toHaveLength(3);
  });

  it('registry down: service_unavailable, nothing sequenced; branch.update still passes', async () => {
    const env = signalEnv();
    const a = env.agentOf(env.host);
    env.down.on = true;
    const out = await env.send(conflict([a], ['h']), env.host);
    expect(out.error).toMatchObject({ p: { code: 'service_unavailable', retry_after_s: 1 } });
    expect(env.sequenced).toEqual([]);
    expect((await env.send(branchUpdate(), env.host)).passed).toBe(true);
    expect(env.sequenced).toHaveLength(1);
  });

  it('an exited agent may not be named', async () => {
    const env = signalEnv();
    const [a, b] = [env.agentOf(env.host), env.agentOf(env.editor)];
    env.exited.add(b);
    expect((await env.send(conflict([a, b], ['h']), env.host)).error).toMatchObject({
      p: { code: 'invalid_frame' },
    });
    await env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' });
    expect(env.emitted).toEqual([]);
  });

  it('a refused sequencing frees the window; an unknown outcome keeps it', async () => {
    const env = signalEnv();
    const [a, b] = [env.agentOf(env.host), env.agentOf(env.editor)];
    const ctx = (result: undefined | 'unknown') => ({
      sid: env.sid,
      sender: env.host,
      sequence: () => Promise.resolve(result),
    });
    const f1 = conflict([a, b], ['h']);
    expect(
      await env.conflicts.onConflictDetected(ctx(undefined), { id: String(f1['id']), p: f1['p'] }),
    ).toEqual({ outcome: 'ignored' });
    // Freed: the same set from another frame passes.
    expect((await env.send(conflict([a, b], ['h']), env.host)).passed).toBe(true);
    const f2 = conflict([a, b], ['other']);
    expect(
      await env.conflicts.onConflictDetected(ctx('unknown'), { id: String(f2['id']), p: f2['p'] }),
    ).toEqual({ outcome: 'ignored' });
    // Kept: it may be in the log.
    expect((await env.send(conflict([a, b], ['other']), env.host)).error).toMatchObject({
      p: { code: 'conflict' },
    });
  });
});

describe('server conflict.detected from lock denials (acceptance 4, 5)', () => {
  it('one per pair per 30 s; two pairs give two; agent ids and the one path hash only', async () => {
    const env = signalEnv();
    const [a, b, c] = [env.agentOf(env.host), env.agentOf(env.editor), env.agentOf(env.host)];
    const deny = (holder: string, requester: string, path = 'P1') =>
      env.conflicts.onLockDenied(env.sid, {
        holderAgent: holder,
        requesterAgent: requester,
        pathHmac: path,
      });
    await deny(a, b);
    await deny(a, b);
    await deny(b, a, 'P2');
    expect(env.emitted).toEqual([{ sid: env.sid, p: { agent_ids: [a, b], path_hmacs: ['P1'] } }]);
    await deny(a, c);
    expect(env.emitted).toHaveLength(2);
    env.clock.now += 30_000;
    await deny(a, b);
    expect(env.emitted).toHaveLength(3);
    expect(env.recorded.count('relay_conflicts_signalled_total', { source: 'server' })).toBe(3);
    expect(
      env.recorded.count('relay_conflict_signals_dropped_total', { reason: 'duplicate' }),
    ).toBe(2);
    for (const e of env.emitted)
      expect(Object.keys(e.p).sort()).toEqual(['agent_ids', 'path_hmacs']);
  });

  it('caps a burst at 10 per session per second; the rest are counted and dropped', async () => {
    const env = signalEnv();
    const holder = env.agentOf(env.host);
    const requesters = Array.from({ length: 30 }, () => env.agentOf(env.editor));
    await Promise.all(
      requesters.map((r) =>
        env.conflicts.onLockDenied(env.sid, {
          holderAgent: holder,
          requesterAgent: r,
          pathHmac: 'P',
        }),
      ),
    );
    expect(env.emitted).toHaveLength(10);
    expect(env.recorded.count('relay_conflict_signals_dropped_total', { reason: 'rate' })).toBe(20);
    // A pair dropped by the cap is not silenced: a second later it is signalled.
    env.clock.now += 1_000;
    await env.conflicts.onLockDenied(env.sid, {
      holderAgent: holder,
      requesterAgent: requesters[29] ?? '',
      pathHmac: 'P',
    });
    expect(env.emitted).toHaveLength(11);
  });

  it('drops unknown agents and agents of members gone; never signals itself', async () => {
    const env = signalEnv();
    const a = env.agentOf(env.host);
    const b = env.agentOf(env.editor);
    await env.conflicts.onLockDenied(env.sid, {
      holderAgent: a,
      requesterAgent: newId('agt'),
      pathHmac: 'P',
    });
    env.connected.delete(env.editor.memberId);
    await env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' });
    await env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: a, pathHmac: 'P' });
    expect(env.emitted).toEqual([]);
    // An ineligible pair is not silenced: once its owner is back, the next denial is signalled.
    env.connected.add(env.editor.memberId);
    await env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' });
    expect(env.emitted).toHaveLength(1);
    expect(
      env.recorded.count('relay_conflict_signals_dropped_total', { reason: 'ineligible' }),
    ).toBe(2);
  });

  it('registry down (Redis up): dropped and counted, and the pair window is freed', async () => {
    const env = signalEnv();
    const [a, b] = [env.agentOf(env.host), env.agentOf(env.editor)];
    env.registryDown.on = true;
    await expect(
      env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' }),
    ).resolves.toBeUndefined();
    expect(env.emitted).toEqual([]);
    expect(
      env.recorded.count('relay_conflict_signals_dropped_total', { reason: 'unavailable' }),
    ).toBe(1);
    env.registryDown.on = false;
    // Within 30 s, the same pair is signalled once the registry is back.
    env.clock.now += 1_000;
    await env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' });
    expect(env.emitted).toHaveLength(1);
  });

  it('a failed emit keeps the pair window (the frame may be stored)', async () => {
    const env = signalEnv();
    const [a, b] = [env.agentOf(env.host), env.agentOf(env.editor)];
    const failing = new (await import('../../src/branches/conflict-signal.js')).ConflictSignal({
      ...env.conflictDeps,
      emitter: { emit: () => Promise.reject(new Error('fan-out down')) },
    });
    await failing.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' });
    await env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' });
    expect(env.emitted).toEqual([]);
  });

  it('Redis down: the signal is dropped, never thrown', async () => {
    const env = signalEnv();
    const [a, b] = [env.agentOf(env.host), env.agentOf(env.editor)];
    env.down.on = true;
    await expect(
      env.conflicts.onLockDenied(env.sid, { holderAgent: a, requesterAgent: b, pathHmac: 'P' }),
    ).resolves.toBeUndefined();
    expect(env.emitted).toEqual([]);
    expect(
      env.recorded.count('relay_conflict_signals_dropped_total', { reason: 'unavailable' }),
    ).toBe(1);
  });
});
