/**
 * B059 contract (CT-WS-SESSION-EVENTS `file.lock`): the fixture validates against the event
 * schema and is accepted (its `ttl_ms` of 3 clamped to the contract minimum); every frame the
 * service emits validates too; `deny` and `expire` from a client are refused (the server's);
 * malformed frames are `invalid_frame`; the stage answers refusals with `sys.error` to the sender
 * and passes non-lock frames on.
 */
import { newId, validateEvent } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { lockStage } from '../../src/locks/stage.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';
import { fixture, lock, lockEnv } from './helpers.js';

describe('file.lock contract', () => {
  it('accepts the fixture, clamping its ttl_ms to 5 000', async () => {
    const env = lockEnv();
    const f = fixture();
    expect(validateEvent('file.lock', f['p']).ok).toBe(true);
    expect(await env.send({ id: String(f['id']), p: f['p'] }, env.host)).toEqual({
      outcome: 'granted',
    });
    const raw = await env.redis.kv.get(`lock:${env.sid}:AAAA`);
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ expires_at: env.clock.now + 5_000 });
  });

  it('emits only schema-valid frames', async () => {
    const env = lockEnv();
    const [a, b] = [newId('agt'), newId('agt')];
    await env.send(lock('acquire', 'x', a, 5_000), env.editor);
    await env.send(lock('acquire', 'x', b), env.other);
    env.clock.now += 5_000;
    await env.service.sweep(new Date(env.clock.now));
    const frames = env.serverFrames();
    expect(frames.map((p) => p['action']).sort()).toEqual(['acquire', 'deny', 'expire']);
    for (const p of frames) expect(validateEvent('file.lock', p).ok, JSON.stringify(p)).toBe(true);
  });

  it('refuses deny and expire from clients, and malformed frames', async () => {
    const env = lockEnv();
    for (const action of ['deny', 'expire']) {
      expect(await env.send(lock(action, 'x', newId('agt')), env.host)).toMatchObject({
        outcome: 'refused',
        code: 'invalid_frame',
      });
    }
    for (const p of [
      null,
      {},
      { action: 'acquire', path_hmac: 'x' },
      { action: 'grab', path_hmac: 'x', agent_id: newId('agt') },
    ]) {
      expect(await env.send({ id: newId('msg'), p }, env.host)).toMatchObject({
        code: 'invalid_frame',
      });
    }
    expect(env.sequenced).toEqual([]);
  });

  it('the stage answers a refusal with sys.error (ref = frame id) and passes other frames', async () => {
    const env = lockEnv();
    const stage = lockStage({
      service: env.service,
      rooms: {
        locate: () =>
          ({ room: { sid: env.sid }, member: { id: env.host.memberId, role: 'host' } }) as never,
      },
    });
    const sent: Record<string, unknown>[] = [];
    const conn = {
      send: (f: object) => (sent.push(f as Record<string, unknown>), true),
    } as unknown as RelayConnection;
    const bad = lock('deny', 'x', newId('agt'));
    const fc: FrameContext = {
      connection: conn,
      raw: null,
      frame: { v: 1, t: 'event', id: bad.id, k: 'file.lock', p: bad.p },
      state: {},
    };
    let nexts = 0;
    await stage(fc, () => {
      nexts += 1;
      return Promise.resolve();
    });
    expect(nexts).toBe(0);
    expect(sent).toEqual([
      expect.objectContaining({
        t: 'sys.error',
        ref: bad.id,
        p: expect.objectContaining({ code: 'invalid_frame' }),
      }),
    ]);
    await stage(
      {
        connection: conn,
        raw: null,
        frame: { v: 1, t: 'event', id: newId('msg'), k: 'message.user' },
        state: {},
      },
      () => {
        nexts += 1;
        return Promise.resolve();
      },
    );
    expect(nexts).toBe(1);
  });
});
