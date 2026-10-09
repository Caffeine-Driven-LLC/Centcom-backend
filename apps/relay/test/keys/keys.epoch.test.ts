/**
 * The epoch tracker and signal (B049; tests "keys.epoch.test.ts", acceptance 3 and 7, guardrails
 * "epoch state survives restarts" and "rotate_key only from the server"): `rotate(sid,
 * "member_removed")` emits `control.rotate_key {kid: "k2", reason: "member_removed"}` from `srv`
 * with the `seq` right after the preceding frame, the next yields `k3`; other reasons throw. A host's
 * `control.rotate_request` emits exactly one `rotate_key` for the next epoch, and a resend of the
 * same id emits nothing new. The state is in the store: a new tracker (a restarted relay) sees it.
 * On Redis 7 too (`relay:ses:{sid}:epoch`), when a Redis is there.
 */
import { newId } from '@centcom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisEpochStore, epochKey } from '../../src/keys/epoch-store.js';
import { createEpochs } from '../../src/keys/epochs.js';
import { authorizeFrame, noMutes } from '../../src/rooms/kind-policy.js';
import {
  REDIS,
  REDIS_TIMEOUT_MS,
  startRedisHarness,
  type RedisHarness,
} from '../seq/redis-helpers.js';
import { reactionFrame } from '../resume/helpers.js';
import { keysUnit } from './helpers.js';

const rotations = (frames: Record<string, unknown>[]) =>
  frames.filter((f) => f['k'] === 'control.rotate_key');

describe('rotate (acceptance 3)', () => {
  it('k2 right after the preceding frame, then k3; from srv; recorded as current', async () => {
    const u = keysUnit();
    const { conn } = u.member('host');
    await u.send(conn, reactionFrame(u.sid));
    expect(await u.epochs.rotate(u.sid, 'member_removed')).toEqual({ seq: 2, kid: 'k2' });
    expect(await u.epochs.rotate(u.sid, 'scheduled')).toEqual({ seq: 3, kid: 'k3' });
    expect(rotations(conn.frames())).toEqual([
      expect.objectContaining({
        from: 'srv',
        t: 'control',
        seq: 2,
        p: { kid: 'k2', reason: 'member_removed' },
      }),
      expect.objectContaining({ from: 'srv', seq: 3, p: { kid: 'k3', reason: 'scheduled' } }),
    ]);
    expect(await u.epochs.current(u.sid)).toMatchObject({ kid: 'k3', epoch: 3, framesSince: 0 });
    expect(u.recorded.count('relay_epoch_rotations_total', { reason: 'member_removed' })).toBe(1);
  });

  it('refuses a reason outside the three', async () => {
    const u = keysUnit();
    await expect(u.epochs.rotate(u.sid, 'boredom' as never)).rejects.toThrow(TypeError);
    expect(await u.store.head(u.sid)).toBe(0);
  });

  it('survives a restart: a new tracker over the same store', async () => {
    const u = keysUnit();
    await u.epochs.rotate(u.sid, 'requested');
    const restarted = createEpochs({ store: u.epochStore, seq: u.store, fanout: () => u.fanout });
    expect(await restarted.current(u.sid)).toMatchObject({ kid: 'k2' });
    expect(await restarted.check(u.sid, 'k3', 0)).toBe('future');
    expect((await restarted.rotate(u.sid, 'requested')).kid).toBe('k3');
  });

  it('advance sets a newer epoch as current, never an older one', async () => {
    const u = keysUnit();
    await u.epochs.advance(u.sid, 'k4');
    expect((await u.epochs.current(u.sid)).kid).toBe('k4');
    await u.epochs.advance(u.sid, 'k2');
    expect((await u.epochs.current(u.sid)).kid).toBe('k4');
    await expect(u.epochs.advance(u.sid, 'x')).rejects.toThrow(TypeError);
  });
});

describe('control.rotate_request (acceptance 7)', () => {
  it('a host request emits exactly one rotate_key k2; a resend emits nothing', async () => {
    const u = keysUnit();
    const host = u.member('host');
    const request = {
      v: 1,
      t: 'control',
      id: newId('msg'),
      sid: u.sid,
      k: 'control.rotate_request',
      p: { reason: 'requested' },
    };
    expect((await u.send(host.conn, request))?.seq).toBe(1);
    await u.send(host.conn, request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rotations(host.conn.frames())).toEqual([
      expect.objectContaining({ seq: 2, p: { kid: 'k2', reason: 'requested' } }),
    ]);
    expect(await u.store.head(u.sid)).toBe(2);
  });

  it('an editor’s request is forbidden; a client rotate_key can never bump the epoch', async () => {
    const editor = { id: newId('mem'), sid: newId('ses'), role: 'editor' as const };
    expect(
      authorizeFrame(editor, { t: 'control', k: 'control.rotate_request' }, noMutes),
    ).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    const host = { ...editor, role: 'host' as const };
    expect(authorizeFrame(host, { t: 'control', k: 'control.rotate_key' }, noMutes)).toMatchObject({
      ok: false,
    });
    // Even past authorisation, the rotation stage acts only on rotate_request.
    const u = keysUnit();
    const h = u.member('host');
    await u.send(h.conn, {
      v: 1,
      t: 'control',
      id: newId('msg'),
      sid: u.sid,
      k: 'control.rotate_key',
      p: { kid: 'k9', reason: 'requested' },
    });
    expect((await u.epochs.current(u.sid)).kid).toBe('k1');
  });

  it('a request a scheduled one asks for says so', async () => {
    const u = keysUnit();
    const host = u.member('host');
    await u.send(host.conn, {
      v: 1,
      t: 'control',
      id: newId('msg'),
      sid: u.sid,
      k: 'control.rotate_request',
      p: { reason: 'scheduled' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(rotations(host.conn.frames())[0]?.['p']).toEqual({ kid: 'k2', reason: 'scheduled' });
  });
});

describe.runIf(REDIS)('the epoch store on Redis 7', () => {
  let redis: RedisHarness;
  beforeAll(async () => {
    redis = await startRedisHarness();
  }, REDIS_TIMEOUT_MS);
  afterAll(async () => {
    await redis.cleanup();
  });

  it('keeps the counter, the current epoch and every rotation seq, with a TTL', async () => {
    const prefix = redis.prefix();
    const store = createRedisEpochStore(redis.client(prefix));
    const sid = newId('ses');
    expect(await store.read(sid)).toMatchObject({ current: 1, seq: 0 });
    expect(await store.next(sid)).toBe(2);
    expect(await store.next(sid)).toBe(3);
    await store.announce(sid, 3, 40, 1_000);
    await store.announce(sid, 2, 30, 900);
    const state = await store.read(sid);
    expect(state).toMatchObject({ current: 3, seq: 40, startedAt: 1_000 });
    expect([...state.rotations]).toEqual(
      expect.arrayContaining([
        [2, 30],
        [3, 40],
      ]),
    );
    expect(await redis.admin.pttl(`${prefix}${epochKey(sid)}`)).toBeGreaterThan(0);
  }, 120_000);
});
