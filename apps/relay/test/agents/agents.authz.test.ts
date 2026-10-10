/**
 * B057 authorisation (acceptance 2; guardrail: no owner spoofing). The mode is the session's (every
 * session on main is a command post; tests inject a branch session): in a command-post session
 * only the host spawns, updates or ends agents, whatever mode a frame declares; in a branch
 * session an editor spawns only with `owner` = their own member id and controls only their own
 * agents; the host controls every agent; a spawn declaring another mode than the session's is
 * `invalid_frame`; nobody can re-emit someone else's spawn frame.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { agentEnv, exit, spawn, state } from './helpers.js';

describe('command-post sessions (acceptance 2)', () => {
  it("an editor's spawn is forbidden, whatever mode it declares; the host may spawn for anyone", async () => {
    const env = agentEnv();
    for (const mode of ['command_post', 'branch'] as const) {
      expect(await env.send(spawn({ owner: env.editor.memberId, mode }), env.editor)).toMatchObject(
        {
          outcome: 'refused',
          code: 'forbidden',
        },
      );
    }
    expect(env.seq.sequenced).toHaveLength(0);
    expect(await env.send(spawn({ owner: env.editor.memberId }), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
  });

  it('a spawn declaring branch mode in a command-post session is invalid_frame, even from the host', async () => {
    const env = agentEnv();
    expect(
      await env.send(spawn({ owner: env.host.memberId, mode: 'branch' }), env.host),
    ).toMatchObject({
      outcome: 'refused',
      code: 'invalid_frame',
    });
  });

  it('an editor may not change or end an agent', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.editor.memberId });
    await env.send(s, env.host);
    expect(await env.send(state(s.agentId, 'thinking'), env.editor)).toMatchObject({
      code: 'forbidden',
    });
    expect(await env.send(exit(s.agentId), env.editor)).toMatchObject({ code: 'forbidden' });
    expect(await env.send(state(s.agentId, 'thinking'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
  });

  it("nobody can re-emit the host's spawn frame: refused and not sequenced", async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    const before = env.seq.sequenced.length;
    const altered = { ...(s.p as Record<string, unknown>), owner: env.editor.memberId };
    for (const p of [s.p, altered]) {
      expect(await env.send({ ...s, p }, env.editor)).toMatchObject({
        outcome: 'refused',
        code: 'forbidden',
      });
    }
    // The host's own copy with another owner is not a resend either.
    expect(await env.send({ ...s, p: altered }, env.host)).toMatchObject({ code: 'invalid_frame' });
    expect(env.seq.sequenced).toHaveLength(before);
    expect(env.registry.get(env.sid, s.agentId)?.owner).toBe(env.host.memberId);
  });

  it('an editor gets forbidden for any agent frame, known, unknown or exited', async () => {
    const env = agentEnv();
    const s = spawn({ owner: env.host.memberId });
    await env.send(s, env.host);
    const gone = spawn({ owner: env.host.memberId });
    await env.send(gone, env.host);
    await env.send(exit(gone.agentId), env.host);
    for (const frame of [
      spawn({ owner: env.editor.memberId, agent: s.agentId }),
      state(s.agentId, 'thinking'),
      state(newId('agt'), 'thinking'),
      state(gone.agentId, 'thinking'),
      exit(newId('agt')),
    ]) {
      expect(await env.send(frame, env.editor), frame.k).toMatchObject({ code: 'forbidden' });
    }
  });
});

describe('branch sessions (acceptance 2)', () => {
  it('an editor spawns with owner = self, not with owner = another member', async () => {
    const env = agentEnv({ mode: 'branch' });
    const own = spawn({ owner: env.editor.memberId, mode: 'branch' });
    expect(await env.send(own, env.editor)).toMatchObject({ outcome: 'sequenced' });
    expect(env.registry.get(env.sid, own.agentId)).toMatchObject({
      owner: env.editor.memberId,
      mode: 'branch',
    });
    const spoofed = spawn({ owner: env.other.memberId, mode: 'branch' });
    expect(await env.send(spoofed, env.editor)).toMatchObject({
      outcome: 'refused',
      code: 'forbidden',
    });
    expect(env.registry.get(env.sid, spoofed.agentId)).toBeUndefined();
    expect(
      await env.send(spawn({ owner: env.editor.memberId, mode: 'command_post' }), env.editor),
    ).toMatchObject({ code: 'invalid_frame' });
  });

  it('only the owner or the host controls an agent', async () => {
    const env = agentEnv({ mode: 'branch' });
    const own = spawn({ owner: env.editor.memberId, mode: 'branch' });
    await env.send(own, env.editor);
    expect(await env.send(state(own.agentId, 'thinking'), env.other)).toMatchObject({
      code: 'forbidden',
    });
    expect(await env.send(state(own.agentId, 'thinking'), env.editor)).toMatchObject({
      outcome: 'sequenced',
    });
    env.clock.now += 1_000;
    expect(await env.send(state(own.agentId, 'planning'), env.host)).toMatchObject({
      outcome: 'sequenced',
    });
    expect(await env.send(exit(own.agentId), env.other)).toMatchObject({ code: 'forbidden' });
    expect(await env.send(exit(own.agentId), env.editor)).toMatchObject({ outcome: 'sequenced' });
  });

  it('the host may spawn an agent owned by another member', async () => {
    const env = agentEnv({ mode: 'branch' });
    expect(
      await env.send(spawn({ owner: env.editor.memberId, mode: 'branch' }), env.host),
    ).toMatchObject({ outcome: 'sequenced' });
  });
});
