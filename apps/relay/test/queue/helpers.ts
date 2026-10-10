/**
 * Test helpers for the queue (B052): `queueUnit()` wires, as the modules do, B043's authorise
 * stage (20, with B051's mutes), the queue stage (39), B041's sequencing (40) and B044's fan-out
 * (50), over B051's in-memory policy store and an in-memory queue store, with the host-loss
 * listener on the rooms. `member(role)` connects a member; `submit`, `op` and `reorder` build
 * frames; `state()` is the last `queue.state` a connection received.
 */
import { newId } from '@centcom/contracts';
import type { RelayConnection } from '../../src/pipeline.js';
import { createQueueService, type QueueServiceDeps } from '../../src/queue/service.js';
import { queueStage } from '../../src/queue/stage.js';
import { createMemoryQueueStore } from '../../src/queue/store.js';
import type { QueueStateBody } from '../../src/queue/state-machine.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../../src/seq/types.js';
import type { TextConnection } from '../fanout/helpers.js';
import { controlUnit } from '../control/helpers.js';

/** The queue's frame path on in-memory fakes. */
export function queueUnit(opts: { service?: Partial<QueueServiceDeps> } = {}) {
  const u = controlUnit();
  const queueStore = createMemoryQueueStore();
  const service = createQueueService({
    store: queueStore,
    policies: u.policies,
    sequencer: {
      emitState: (sid, body) => u.fanout.emitServer(sid, 'queue.state', 'queue', { ...body }),
      framesAfter: (sid, after) => u.store.range(sid, after, 1_000),
      async resend(conn, sid, seq) {
        const [frame] = await u.store.range(sid, seq - 1, 1);
        if (frame === undefined) return false;
        u.fanout.sendTo(conn, frame);
        return true;
      },
    },
    audit: { emitDetached: (e) => void u.audited.push(e) },
    clock: () => u.clock.now,
    metrics: u.recorded.metrics,
    logger: u.log.logger,
    ...opts.service,
  });
  u.rooms.listen({
    joined(room, _conn, member) {
      if (member.role === 'host') void service.onHostReconnected(room.sid);
    },
    left(room, _conn, member) {
      if (member.role === 'host' && !room.hasMember(member.id)) {
        void service.onHostDisconnected(room.sid);
      }
    },
  });
  const stage = queueStage({ service, rooms: u.rooms });

  /** Runs `frame` through the stages; the stored frame when it was sequenced. */
  async function send(
    conn: RelayConnection,
    frame: Record<string, unknown>,
  ): Promise<StoredFrame | undefined> {
    const fc = {
      connection: conn,
      raw: JSON.stringify(frame),
      frame,
      state: {} as Record<string, unknown>,
    };
    await u.roomSide.stage(fc, () =>
      stage(fc, () => u.sequencer.stage(fc, () => u.fanout.stage(fc, () => Promise.resolve()))),
    );
    return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
  }

  /** A `queue.submit` of a new item (or `item`), with `size` bytes. */
  const submit = (opts: { item?: string; size?: number; id?: string } = {}) => ({
    v: 1,
    t: 'queue',
    id: opts.id ?? newId('msg'),
    sid: u.sid,
    k: 'queue.submit',
    p: { item: opts.item ?? newId('que'), size: opts.size ?? 3, kind: 'message' },
    ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'n'.repeat(32), c: 'Y2lwaGVy' },
    sig: 's'.repeat(86),
  });

  /** A queue frame `kind` with `p`. */
  const op = (kind: string, p: Record<string, unknown>, id = newId('msg')) => ({
    v: 1,
    t: 'queue',
    id,
    sid: u.sid,
    k: kind,
    p,
  });

  /** The item id of a submit frame. */
  const itemOf = (frame: { p: { item: string } }) => frame.p.item;

  /** The last `queue.state` body `conn` received. */
  const stateOf = (conn: TextConnection): QueueStateBody | undefined => {
    const frames = conn.frames().filter((f) => f['k'] === 'queue.state');
    return frames.at(-1)?.['p'] as QueueStateBody | undefined;
  };

  /** Lets queued promises (the host-loss listener's) run. */
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  /** Sets the session's policy (B051's store). */
  const policy = (p: Partial<Awaited<ReturnType<typeof u.policies.get>>>) =>
    u.policies.get(u.sid).then((current) => u.policies.set(u.sid, { ...current, ...p }, 1));

  return {
    ...u,
    queueStore,
    service,
    send,
    submit,
    op,
    itemOf,
    stateOf,
    settle,
    policy,
  };
}
