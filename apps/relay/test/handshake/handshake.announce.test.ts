/**
 * The first-join announcement (CT-WS-CONTROL `control.member_joined`): sent once per member and
 * session, never on a reconnect, not at all without fan-out, and undone when the emit fails.
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it, vi } from 'vitest';
import { announceJoin, announcedKey } from '../../src/handshake/announce.js';
import type { AdmittedHello } from '../../src/handshake/handshake.js';

const admitted = (mid = 'mem_01AAAAAAAAAAAAAAAAAAAAAAAA'): AdmittedHello => ({
  sid: 'ses_01AAAAAAAAAAAAAAAAAAAAAAAA',
  dev: 'dev_01AAAAAAAAAAAAAAAAAAAAAAAA',
  lastSeq: null,
  access: {
    session: { state: 'live', maxMembers: 10 },
    member: { id: mid, name: 'Max Member', slot: 1, role: 'editor' },
    deviceRevoked: false,
    relayAccess: true,
  },
});

describe('announceJoin', () => {
  it('sequences control.member_joined for the first connection of a member', async () => {
    const kv = createMemoryRedis().kv;
    const emitServer = vi.fn().mockResolvedValue({});
    await announceJoin({ kv, emitServer }, admitted());
    expect(emitServer).toHaveBeenCalledWith(
      'ses_01AAAAAAAAAAAAAAAAAAAAAAAA',
      'control.member_joined',
      'control',
      {
        member: 'mem_01AAAAAAAAAAAAAAAAAAAAAAAA',
        name: 'Max Member',
        slot: 1,
        role: 'editor',
        device: 'dev_01AAAAAAAAAAAAAAAAAAAAAAAA',
      },
    );
  });

  it('does not announce a reconnect, but does announce another member', async () => {
    const kv = createMemoryRedis().kv;
    const emitServer = vi.fn().mockResolvedValue({});
    await announceJoin({ kv, emitServer }, admitted());
    await announceJoin({ kv, emitServer }, admitted());
    expect(emitServer).toHaveBeenCalledTimes(1);
    await announceJoin({ kv, emitServer }, admitted('mem_01BBBBBBBBBBBBBBBBBBBBBBBB'));
    expect(emitServer).toHaveBeenCalledTimes(2);
  });

  it('announces nothing on a relay without fan-out', async () => {
    const kv = createMemoryRedis().kv;
    await expect(announceJoin({ kv, emitServer: undefined }, admitted())).resolves.toBeUndefined();
    const a = admitted();
    expect(await kv.get(announcedKey(a.sid, a.access.member.id))).toBeNull();
  });

  it('forgets the marker when the emit fails, so the next connection announces, and never throws', async () => {
    const kv = createMemoryRedis().kv;
    const emitServer = vi.fn().mockRejectedValueOnce(new Error('store down')).mockResolvedValue({});
    await expect(announceJoin({ kv, emitServer }, admitted())).resolves.toBeUndefined();
    await announceJoin({ kv, emitServer }, admitted());
    expect(emitServer).toHaveBeenCalledTimes(2);
  });
});
