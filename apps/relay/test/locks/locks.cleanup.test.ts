/**
 * B059 cleanup (acceptance 5; guardrail: a lock is released when its owner can no longer act):
 * an `agent.exit` for an agent holding 3 locks frees all 3 with 3 sequenced `expire` frames (and
 * grants waiters); the same for a kicked member (`control.kick`, 3 locks) and for the whole
 * session on `control.end`; the stage does it once those frames are sequenced, and drops the
 * owner's waiters. A disconnect is not a leave (the TTL bounds an absent member's locks).
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import type { LockSender } from '../../src/locks/ports.js';
import { lockStage } from '../../src/locks/stage.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';
import { SEQUENCED_STATE_KEY } from '../../src/seq/types.js';
import { lock, lockEnv } from './helpers.js';

/** Runs `frame` through the stage as `member`, sequencing it. */
async function throughStage(
  env: ReturnType<typeof lockEnv>,
  frame: Record<string, unknown>,
  member: LockSender,
) {
  const stage = lockStage({
    service: env.service,
    rooms: {
      locate: () =>
        ({
          room: { sid: env.sid },
          member: { id: member.memberId, role: member.role, sid: env.sid },
        }) as never,
    },
  });
  const fc: FrameContext = {
    connection: { send: () => true } as unknown as RelayConnection,
    raw: null,
    frame,
    state: {},
  };
  await stage(fc, () => {
    fc.state[SEQUENCED_STATE_KEY] = { ...frame, seq: 1 };
    return Promise.resolve();
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('cleanup (acceptance 5)', () => {
  it('agent.exit frees its 3 locks with 3 expire frames and grants a waiter', async () => {
    const env = lockEnv();
    const a = newId('agt');
    const w = newId('agt');
    for (const path of ['p1', 'p2', 'p3']) await env.send(lock('acquire', path, a), env.editor);
    await env.send(lock('acquire', 'p2', w), env.other);
    env.emitted.length = 0;
    await throughStage(
      env,
      { v: 1, t: 'event', id: newId('msg'), k: 'agent.exit', p: { agent_id: a, outcome: 'ok' } },
      env.host,
    );
    await settle();
    const expires = env.emitted.filter((e) => e.p['action'] === 'expire');
    expect(expires.map((e) => e.p['path_hmac']).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(expires.every((e) => e.p['agent_id'] === a)).toBe(true);
    expect(env.emitted.filter((e) => e.p['action'] === 'acquire').map((e) => e.p)).toEqual([
      { action: 'acquire', path_hmac: 'p2', agent_id: w, ttl_ms: 300_000 },
    ]);
  });

  it('a control.kick frees the kicked member’s locks and drops their waiters', async () => {
    const env = lockEnv();
    const a = newId('agt');
    const b = newId('agt');
    for (const path of ['p1', 'p2', 'p3']) await env.send(lock('acquire', path, a), env.editor);
    await env.send(lock('acquire', 'q', b), env.other);
    await env.send(lock('acquire', 'q', newId('agt')), env.editor);
    env.emitted.length = 0;
    await throughStage(
      env,
      {
        v: 1,
        t: 'control',
        id: newId('msg'),
        k: 'control.kick',
        p: { member: env.editor.memberId, code: 'removed' },
      },
      env.host,
    );
    await settle();
    expect(
      env.emitted
        .filter((e) => e.p['action'] === 'expire')
        .map((e) => e.p['path_hmac'])
        .sort(),
    ).toEqual(['p1', 'p2', 'p3']);
    // The editor's waiter on q is gone: releasing q grants nobody.
    expect(await env.send(lock('release', 'q', b), env.other)).toEqual({ outcome: 'released' });
    expect(env.sequenced.at(-1)?.from).not.toBe('srv');
  });

  it('control.end frees every lock of the session', async () => {
    const env = lockEnv();
    await env.send(lock('acquire', 'p1', newId('agt')), env.editor);
    await env.send(lock('acquire', 'p2', newId('agt')), env.other);
    await throughStage(
      env,
      { v: 1, t: 'control', id: newId('msg'), k: 'control.end', p: { reason: 'done' } },
      env.host,
    );
    await settle();
    expect(env.emitted.filter((e) => e.p['action'] === 'expire')).toHaveLength(2);
  });

  it('releaseAllForMember frees a member’s locks once, and only theirs', async () => {
    const env = lockEnv();
    const a = newId('agt');
    for (const path of ['p1', 'p2', 'p3']) await env.send(lock('acquire', path, a), env.editor);
    expect(await env.service.releaseAllForMember(env.sid, env.editor.memberId)).toBe(3);
    expect(env.emitted.filter((e) => e.p['action'] === 'expire')).toHaveLength(3);
    expect(await env.service.releaseAllForMember(env.sid, env.editor.memberId)).toBe(0);
  });

  it('frames that are not sequenced trigger no cleanup; other kinds pass untouched', async () => {
    const env = lockEnv();
    const a = newId('agt');
    await env.send(lock('acquire', 'p1', a), env.editor);
    const stage = lockStage({
      service: env.service,
      rooms: {
        locate: () =>
          ({ room: { sid: env.sid }, member: { id: env.host.memberId, role: 'host' } }) as never,
      },
    });
    let passed = 0;
    await stage(
      {
        connection: { send: () => true } as unknown as RelayConnection,
        raw: null,
        frame: { v: 1, t: 'event', id: newId('msg'), k: 'agent.exit', p: { agent_id: a } },
        state: {},
      },
      () => {
        passed += 1;
        return Promise.resolve();
      },
    );
    await settle();
    expect(passed).toBe(1);
    expect(env.emitted).toEqual([]);
  });
});

describe('disconnects and leaves (guardrail: member left)', () => {
  it('a member still connected on another node keeps its locks', async () => {
    const env = lockEnv();
    await env.send(lock('acquire', 'p1', newId('agt')), env.editor);
    await env.service.memberJoined(env.sid, env.editor.memberId, 'node-a');
    await env.service.memberJoined(env.sid, env.editor.memberId, 'node-b');
    expect(await env.service.memberLeft(env.sid, env.editor.memberId, 'node-a')).toBeUndefined();
    expect(await env.service.releaseIfGone(env.sid, env.editor.memberId, 'any')).toBe(0);
    expect(env.emitted).toEqual([]);
  });

  it('a member back within the grace keeps its locks; one gone everywhere loses them', async () => {
    const env = lockEnv();
    const a = newId('agt');
    for (const path of ['p1', 'p2', 'p3']) await env.send(lock('acquire', path, a), env.editor);
    await env.service.memberJoined(env.sid, env.editor.memberId, 'node-a');
    const first = await env.service.memberLeft(env.sid, env.editor.memberId, 'node-a');
    expect(first).toBeDefined();
    // Reconnected (on another node) before the grace ended.
    await env.service.memberJoined(env.sid, env.editor.memberId, 'node-b');
    expect(await env.service.releaseIfGone(env.sid, env.editor.memberId, first ?? '')).toBe(0);
    // Gone again: the first departure's grace no longer frees anything; the latest one's does.
    const second = await env.service.memberLeft(env.sid, env.editor.memberId, 'node-b');
    expect(second).toBeDefined();
    expect(await env.service.releaseIfGone(env.sid, env.editor.memberId, first ?? '')).toBe(0);
    expect(await env.service.releaseIfGone(env.sid, env.editor.memberId, second ?? '')).toBe(3);
    expect(env.emitted.filter((e) => e.p['action'] === 'expire')).toHaveLength(3);
  });

  it('a leave from a node the member was never recorded on proves nothing (locks kept)', async () => {
    const env = lockEnv();
    await env.send(lock('acquire', 'p1', newId('agt')), env.editor);
    // Recorded on node-a only (node-b's join was lost, or the document was recreated).
    await env.service.memberJoined(env.sid, env.editor.memberId, 'node-a');
    expect(await env.service.memberLeft(env.sid, env.editor.memberId, 'node-b')).toBeUndefined();
    expect(await env.service.releaseIfGone(env.sid, env.editor.memberId, 'any')).toBe(0);
    expect(env.emitted).toEqual([]);
  });

  it('the module waits the 10 s grace before freeing (LEAVE_GRACE_MS)', async () => {
    const { LEAVE_GRACE_MS } = await import('../../src/locks/ports.js');
    expect(LEAVE_GRACE_MS).toBe(10_000);
  });
});
