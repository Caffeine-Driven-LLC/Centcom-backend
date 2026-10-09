/**
 * The durable log as the relay uses it (B042 over B055, guardrail "Replayed frames MUST be
 * byte-identical"): a frame written through `historyDurableAppend` (B055's writer and store) and
 * read back through `historyLogReader` is the same JSON the hot buffer and fan-out sent: `ref`,
 * `k`, `p`, `ct` and `sig` included, for client and server frames. A frame the log refuses
 * (plaintext `p` on an encrypted kind) is not retried; other failures are. On Postgres 16 with
 * B055's tables when a test stack can start.
 */
import { newId } from '@centcom/contracts';
import {
  createHistoryStore,
  createMemoryBlobStore,
  HistoryFrameRefused,
  HistoryWriter,
  toStoredFrame,
  type HistoryStore,
} from '@centcom/storage';
import { createFactories } from '@centcom/testkit';
import type { createDb, HistoryDatabase } from '@centcom/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  historyDurableAppend,
  historyLogReader,
  relayFrameOf,
} from '../../src/resume/durable-log.js';
import { stampFrame, withSeq } from '../../src/seq/frame.js';
import { SERVER_FROM, type StoredFrame } from '../../src/seq/types.js';
import { STACK, STACK_TIMEOUT_MS, startTestStack, type TestStack } from '../slots/helpers.js';

const CT = { alg: 'xchacha20poly1305' as const, kid: 'k3', n: 'bm9uY2U', c: 'Y2lwaGVy+/==' };

/** Frames of every shape the relay sequences, as B041 stores them. */
function shapes(sid: string): StoredFrame[] {
  const member = newId('mem');
  const ts = '2026-10-09T08:00:00.123Z';
  return [
    stampFrame(
      { t: 'event', id: newId('msg'), k: 'message.user', ct: CT, sig: 'c2ln' },
      member,
      ts,
      sid,
    ),
    stampFrame(
      { t: 'event', id: newId('msg'), ref: newId('msg'), k: 'message.user', ct: CT, sig: 'c2ln' },
      member,
      ts,
      sid,
    ),
    stampFrame(
      {
        t: 'event',
        id: newId('msg'),
        k: 'reaction',
        p: { target: newId('msg'), code: 'thumbs', op: 'add' },
      },
      member,
      ts,
      sid,
    ),
    stampFrame(
      { t: 'queue', id: newId('msg'), k: 'queue.submit', ct: CT, sig: 'c2ln' },
      member,
      ts,
      sid,
    ),
    {
      v: 1,
      t: 'control',
      id: newId('msg'),
      sid,
      from: SERVER_FROM,
      ts,
      k: 'control.member_left',
      p: { member: member },
    } as never,
  ].map((f, i) => withSeq(f, i + 1));
}

describe('relayFrameOf', () => {
  it('rebuilds the exact JSON of every frame shape from what the log keeps', () => {
    const sid = newId('ses');
    for (const frame of shapes(sid)) {
      const kept = toStoredFrame(frame);
      expect(kept.ok, frame.k).toBe(true);
      if (!kept.ok) continue;
      expect(JSON.stringify(relayFrameOf(sid, kept.frame)), frame.k).toBe(JSON.stringify(frame));
    }
  });
});

describe('historyDurableAppend', () => {
  it('resolves once the writer stored the frame; a refused frame is not retried', async () => {
    const outcomes: unknown[] = [];
    const port = historyDurableAppend({
      add: (_sid, frame) => {
        outcomes.push(frame.seq);
        if (frame.seq === 2) return Promise.reject(new HistoryFrameRefused('encrypted_with_p'));
        if (frame.seq === 3) return Promise.reject(new Error('blob store down'));
        return Promise.resolve('stored');
      },
    });
    const [one, two, three] = shapes(newId('ses'));
    await expect(port.append('ses', one as StoredFrame)).resolves.toBeUndefined();
    await expect(port.append('ses', two as StoredFrame)).resolves.toBeUndefined();
    await expect(port.append('ses', three as StoredFrame)).rejects.toThrow('blob store down');
    expect(outcomes).toEqual([1, 2, 3]);
  });
});

describe('historyLogReader', () => {
  it('maps a page to relay frames and reads the head without frames', async () => {
    const sid = newId('ses');
    const frames = shapes(sid);
    const calls: [number, number][] = [];
    const store: Pick<HistoryStore, 'read'> = {
      read: (_sid, afterSeq, limit) => {
        calls.push([afterSeq, limit]);
        const page = frames
          .filter((f) => f.seq > afterSeq)
          .slice(0, limit)
          .map((f) => {
            const kept = toStoredFrame(f);
            if (!kept.ok) throw new Error('not kept');
            return kept.frame;
          });
        return Promise.resolve({ frames: page, nextAfterSeq: null, earliestSeq: 1, headSeq: 5 });
      },
    };
    const reader = historyLogReader(store);
    expect((await reader.range(sid, 1, 2)).map((f) => JSON.stringify(f))).toEqual(
      frames.slice(1, 3).map((f) => JSON.stringify(f)),
    );
    expect(await reader.maxSeq(sid)).toBe(5);
    expect(calls.at(-1)?.[1]).toBe(1);
  });
});

describe.runIf(STACK)('the durable log on Postgres 16', () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack();
  }, STACK_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  });

  it('a frame appended through the writer is read back byte for byte', async () => {
    const f = createFactories(stack.db);
    const workspace = await f.workspaces.create();
    const session = await f.sessions.create({ workspace: workspace.id, state: 'live' });
    const store = createHistoryStore({
      db: stack.db as unknown as ReturnType<typeof createDb<HistoryDatabase>>,
      blobs: createMemoryBlobStore(),
    });
    const writer = new HistoryWriter({ store, maxDelayMs: 10 });
    const port = historyDurableAppend(writer);
    const frames = shapes(session.id);
    await Promise.all(frames.map((frame) => port.append(session.id, frame)));
    const reader = historyLogReader(store);
    expect(await reader.maxSeq(session.id)).toBe(frames.length);
    const back = await reader.range(session.id, 0, 100);
    expect(back.map((x) => JSON.stringify(x))).toEqual(frames.map((x) => JSON.stringify(x)));
  });
});
