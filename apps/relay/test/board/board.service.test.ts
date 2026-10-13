/**
 * B111: the board service and stage. Roles, references, supersedes, the per-member and per-session
 * limits, sequencing order (refusals consume no sequence number), the resend, and the stage's
 * `sys.error` answer.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  BoardService,
  MAX_LIVE_NOTES,
  NOTES_PER_MEMBER_PER_HOUR,
  createMemoryBoardStore,
} from '../../src/board/service.js';
import { boardStage } from '../../src/board/stage.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';
import { SEQUENCED_STATE_KEY } from '../../src/seq/types.js';

type Who = { memberId: string; role: 'host' | 'editor' | 'viewer' };
const SID = newId('ses');
const HOST = { memberId: newId('mem'), role: 'host' as const };
const ANA = { memberId: newId('mem'), role: 'editor' as const };
const BEN = { memberId: newId('mem'), role: 'editor' as const };
const VIEW = { memberId: newId('mem'), role: 'viewer' as const };

function env() {
  const store = createMemoryBoardStore();
  const clock = { now: Date.parse('2026-10-13T12:00:00Z') };
  const redis = createMemoryRedis(() => clock.now);
  const service = new BoardService({ store, rateLimit: redis.rateLimit, clock: () => clock.now });
  let seq = 0;
  const sequenced: string[] = [];
  const sequence = (id: string) => () => {
    seq += 1;
    sequenced.push(id);
    return Promise.resolve({ seq } as never);
  };
  const note = (who: Who, extra: Record<string, unknown> = {}, id = newId('msg')) =>
    service
      .handle(SID, who, { id, k: 'board.note', p: { type: 'decision', ...extra } }, sequence(id))
      .then((r) => ({ id, r }));
  const pin = (who: Who, target: string, pinned = true) =>
    service.handle(
      SID,
      who,
      { id: newId('msg'), k: 'board.pin', p: { target, pinned } },
      sequence('pin'),
    );
  const remove = (who: Who, target: string) =>
    service.handle(
      SID,
      who,
      { id: newId('msg'), k: 'board.remove', p: { target } },
      sequence('remove'),
    );
  return { store, clock, service, note, pin, remove, sequenced, seq: () => seq };
}

describe('board notes', () => {
  it('sequences a note from the host and an editor, records it, refuses a viewer', async () => {
    const e = env();
    expect((await e.note(HOST)).r).toEqual({ outcome: 'sequenced' });
    const a = await e.note(ANA, { type: 'warning' });
    expect(a.r).toEqual({ outcome: 'sequenced' });
    expect(e.store.notes(SID).get(a.id)).toMatchObject({
      author: ANA.memberId,
      type: 'warning',
      pinned: false,
      removed: false,
    });
    const v = await e.note(VIEW);
    expect(v.r).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    expect(e.seq()).toBe(2); // the refusal took no sequence number
  });

  it('a malformed payload is invalid_frame and not sequenced', async () => {
    const e = env();
    const bad = await e.service.handle(
      SID,
      ANA,
      { id: newId('msg'), k: 'board.note', p: { type: 'gossip' } },
      () => Promise.resolve({ seq: 1 } as never),
    );
    expect(bad).toMatchObject({ outcome: 'refused', code: 'invalid_frame' });
  });

  it('pin: any host or editor on a live note; unknown, removed or viewer is refused', async () => {
    const e = env();
    const n = await e.note(ANA);
    expect(await e.pin(BEN, n.id)).toEqual({ outcome: 'sequenced' });
    expect(e.store.notes(SID).get(n.id)?.pinned).toBe(true);
    expect(await e.pin(BEN, n.id, false)).toEqual({ outcome: 'sequenced' });
    expect(e.store.notes(SID).get(n.id)?.pinned).toBe(false);
    expect(await e.pin(ANA, newId('msg'))).toMatchObject({ code: 'invalid_frame' });
    expect(await e.pin(VIEW, n.id)).toMatchObject({ code: 'forbidden' });
    await e.remove(ANA, n.id);
    expect(await e.pin(ANA, n.id)).toMatchObject({ code: 'invalid_frame' });
  });

  it('remove: only the host or the author; a removed note cannot be removed again', async () => {
    const e = env();
    const n = await e.note(ANA);
    expect(await e.remove(BEN, n.id)).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    expect(await e.remove(ANA, n.id)).toEqual({ outcome: 'sequenced' });
    expect(await e.remove(ANA, n.id)).toMatchObject({ code: 'invalid_frame' });
    const m = await e.note(BEN);
    expect(await e.remove(HOST, m.id)).toEqual({ outcome: 'sequenced' });
  });

  it('supersedes: your own note, or any by the host; it retires the old one', async () => {
    const e = env();
    const first = await e.note(ANA);
    const bad = await e.note(BEN, { supersedes: first.id });
    expect(bad.r).toMatchObject({ code: 'forbidden' });
    const mine = await e.note(ANA, { supersedes: first.id });
    expect(mine.r).toEqual({ outcome: 'sequenced' });
    expect(e.store.notes(SID).get(first.id)?.removed).toBe(true);
    const unknown = await e.note(ANA, { supersedes: newId('msg') });
    expect(unknown.r).toMatchObject({ code: 'invalid_frame' });
    const byHost = await e.note(HOST, { supersedes: mine.id });
    expect(byHost.r).toEqual({ outcome: 'sequenced' });
  });

  it('20 notes an hour per member: the 21st is frame_rate_exceeded; the window slides; others are unaffected', async () => {
    const e = env();
    for (let i = 0; i < NOTES_PER_MEMBER_PER_HOUR; i += 1)
      expect((await e.note(ANA)).r.outcome).toBe('sequenced');
    const over = await e.note(ANA);
    expect(over.r).toMatchObject({ outcome: 'refused', code: 'frame_rate_exceeded' });
    expect((await e.note(BEN)).r.outcome).toBe('sequenced');
    expect(e.seq()).toBe(NOTES_PER_MEMBER_PER_HOUR + 1);
    e.clock.now += 3_601_000;
    expect((await e.note(ANA)).r.outcome).toBe('sequenced');
  });

  it('500 live notes per session; removing one makes room', async () => {
    const e = env();
    const ids: string[] = [];
    for (let i = 0; i < MAX_LIVE_NOTES; i += 1) {
      const who = { memberId: newId('mem'), role: 'editor' as const }; // a different member each time: no hourly limit
      ids.push((await e.note(who)).id);
    }
    const over = await e.note({ memberId: newId('mem'), role: 'editor' });
    expect(over.r).toMatchObject({ code: 'frame_rate_exceeded' });
    await e.remove(HOST, ids[0] as string);
    expect((await e.note({ memberId: newId('mem'), role: 'editor' })).r.outcome).toBe('sequenced');
  });

  it('a resend of a note by its author is sequenced again and changes nothing; by someone else it is refused', async () => {
    const e = env();
    const n = await e.note(ANA);
    const again = await e.service.handle(
      SID,
      ANA,
      { id: n.id, k: 'board.note', p: { type: 'decision' } },
      () => Promise.resolve({ seq: 1 } as never),
    );
    expect(again).toEqual({ outcome: 'sequenced' });
    expect([...e.store.notes(SID).keys()]).toEqual([n.id]);
    const stolen = await e.service.handle(
      SID,
      BEN,
      { id: n.id, k: 'board.note', p: { type: 'decision' } },
      () => Promise.resolve({ seq: 1 } as never),
    );
    expect(stolen).toMatchObject({ code: 'invalid_frame' });
  });

  it('a note whose sequencing was refused is not recorded', async () => {
    const e = env();
    const id = newId('msg');
    const r = await e.service.handle(
      SID,
      ANA,
      { id, k: 'board.note', p: { type: 'finding' } },
      () => Promise.resolve(undefined),
    );
    expect(r).toEqual({ outcome: 'ignored' });
    expect(e.store.notes(SID).size).toBe(0);
  });

  it('purge forgets the session', async () => {
    const e = env();
    await e.note(ANA);
    await e.service.purge(SID);
    expect(e.store.notes(SID).size).toBe(0);
  });
});

describe('the board stage', () => {
  function run(frame: Record<string, unknown>, who = ANA, service?: BoardService) {
    const sent: Record<string, unknown>[] = [];
    const conn = {
      send: (f: object) => (sent.push(f as Record<string, unknown>), true),
    } as unknown as RelayConnection;
    const svc = service ?? new BoardService({ store: createMemoryBoardStore() });
    const stage = boardStage({
      board: svc,
      rooms: {
        locate: () =>
          ({ room: { sid: SID }, member: { id: who.memberId, role: who.role, sid: SID } }) as never,
      },
    });
    const fc: FrameContext = { connection: conn, raw: null, frame, state: {} };
    let nexts = 0;
    return stage(fc, () => {
      nexts += 1;
      fc.state[SEQUENCED_STATE_KEY] = { seq: nexts } as never;
      return Promise.resolve();
    }).then(() => ({ sent, nexts }));
  }

  it('sequences an accepted note once and says nothing', async () => {
    const out = await run({
      v: 1,
      t: 'event',
      id: newId('msg'),
      k: 'board.note',
      p: { type: 'finding' },
    });
    expect(out).toEqual({ sent: [], nexts: 1 });
  });

  it('answers a refusal with sys.error (ref = the frame id) and does not sequence', async () => {
    const id = newId('msg');
    const out = await run({
      v: 1,
      t: 'event',
      id,
      k: 'board.pin',
      p: { target: newId('msg'), pinned: true },
    });
    expect(out.nexts).toBe(0);
    expect(out.sent[0]).toMatchObject({ t: 'sys.error', ref: id, p: { code: 'invalid_frame' } });
  });

  it('passes other frames on untouched', async () => {
    const out = await run({ v: 1, t: 'event', id: newId('msg'), k: 'comment.add' });
    expect(out).toEqual({ sent: [], nexts: 1 });
  });
});
