/**
 * Test helpers for keys (B049): `keysUnit()` wires, as the modules do, the keys validation stage
 * (25), B041's sequencing (40), the rotation stage (41) and B044's fan-out (50), over the in-memory
 * stores, with an in-memory epoch store and device directory. `member(role)` joins a welcomed
 * member's connection (B043's room, with a device allowed in the session); `send` runs a frame
 * through the stages; `ack` acknowledges up to a `seq`.
 */
import { newId } from '@centcom/contracts';
import { createMemorySessionDevices } from '../../src/keys/devices.js';
import { createMemoryEpochStore, type EpochStore } from '../../src/keys/epoch-store.js';
import { createEpochs } from '../../src/keys/epochs.js';
import { keysStage, rotateStage } from '../../src/keys/stage.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { SEQUENCED_STATE_KEY, type StoredFrame } from '../../src/seq/types.js';
import { textConnection, type TextConnection } from '../fanout/helpers.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { resumeUnit } from '../resume/helpers.js';

export const CT = (kid = 'k1', c = 'Y2lwaGVy') => ({
  alg: 'xchacha20poly1305',
  kid,
  n: 'n'.repeat(32),
  c,
});

export function keysUnit(opts: { store?: EpochStore } = {}) {
  const u = resumeUnit();
  const recorded = recordingMetrics();
  const log = captureLogger();
  const store = opts.store ?? createMemoryEpochStore();
  const devices = createMemorySessionDevices();
  const epochs = createEpochs({
    store,
    seq: u.store,
    fanout: () => u.fanout,
    metrics: recorded.metrics,
    logger: log.logger,
  });
  const validate = keysStage({
    epochs,
    devices,
    rooms: u.rooms,
    acks: () => u.sequencer.service.acks,
    metrics: recorded.metrics,
  });
  const rotate = rotateStage({ epochs, logger: log.logger, metrics: recorded.metrics });

  /** A welcomed member's connection with role `role`, and its device allowed in the session. */
  function member(role: 'host' | 'editor' | 'viewer' = 'editor') {
    const mid = newId('mem');
    const dev = newId('dev');
    const conn = textConnection(u.registry, u.sid, mid);
    conn.entry.deviceId = dev;
    u.rooms.getOrCreate(u.sid).join(conn, {
      id: mid,
      sid: u.sid,
      role,
      userId: newId('usr'),
      workspaceId: null,
      name: 'M',
      slot: 0,
    });
    u.sequencer.onConnection(conn);
    devices.allow(u.sid, dev);
    return { conn, mid, dev };
  }

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
    await validate(fc, () =>
      u.sequencer.stage(fc, () => rotate(fc, () => u.fanout.stage(fc, () => Promise.resolve()))),
    );
    return fc.state[SEQUENCED_STATE_KEY] as StoredFrame | undefined;
  }

  const ack = (conn: RelayConnection, seq: number) =>
    send(conn, { v: 1, t: 'ack', sid: u.sid, ack: seq });

  /** An encrypted event frame with `kid`. */
  const encrypted = (kid: string, extra: Record<string, unknown> = {}) => ({
    v: 1,
    t: 'event',
    id: newId('msg'),
    sid: u.sid,
    k: 'message.user',
    ct: CT(kid),
    sig: 's'.repeat(86),
    ...extra,
  });

  /** A `key.grant` to `toDevice` for `kids`. */
  const grant = (toDevice: string, kids: unknown[], ct = CT('k1')) => ({
    v: 1,
    t: 'event',
    id: newId('msg'),
    sid: u.sid,
    k: 'key.grant',
    p: { to_device: toDevice, kids },
    ct,
    sig: 's'.repeat(86),
  });

  const errorsOf = (conn: TextConnection) =>
    conn
      .frames()
      .filter((f) => f['t'] === 'sys.error')
      .map((f) => f['p'] as Record<string, unknown>);

  return {
    ...u,
    recorded,
    log,
    epochStore: store,
    devices,
    epochs,
    member,
    send,
    ack,
    encrypted,
    grant,
    errorsOf,
  };
}
