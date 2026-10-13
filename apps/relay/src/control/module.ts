/**
 * The control relay module (B051, order 38 = STAGE_ORDER.control): the control stage, the mutes
 * B043's authorise stage reads, the audit of control frames B043 refuses, and `ctx.control` (the
 * policy store B052 reads).
 *
 * - **Stores:** Postgres (`session_policy`, `session_mute`, `session_members`, `sessions`).
 * - **Sequencing:** B044's `emitServer` and B049's `rotate` (with the kick's `member_left` as
 *   `after`), looked up per frame: their modules register later.
 * - **Connections:** B045's member control, the rooms, and the connected markers on the relay's
 *   Redis (`connections.ts`).
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import { RELAY_CONTROL_CHANNEL } from '@centcom/core';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { roomsFor } from '../rooms/runtime.js';
import { isClientControlKind } from './authority.js';
import { createConnections } from './connections.js';
import { createControlHandler } from './handler.js';
import { createMuteRegistry, createPostgresMuteStore } from './mute-registry.js';
import { createPostgresPolicyStore, type ControlDb } from './policy-store.js';
import { createPostgresMembershipPort, createPostgresSessionState } from './postgres.js';
import type { SequencerPort } from './ports.js';
import { controlStage } from './stage.js';

/** A command from the API on `RELAY_CONTROL_CHANNEL`, every field checked; null for anything else. */
export type ControlCommand =
  | { kind: 'host_changed'; sid: string; host: string; code: 'failover' | 'transfer' }
  | { kind: 'session_state'; sid: string; state: 'live' | 'paused' | 'ended' | 'expired' };

const SID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEM = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseControlCommand(message: string): ControlCommand | null {
  let v: unknown;
  try {
    v = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['sid'] !== 'string' || !SID.test(o['sid'])) return null;
  if (o['kind'] === 'host_changed') {
    const host = o['host'];
    const code = o['code'];
    if (typeof host !== 'string' || !MEM.test(host)) return null;
    if (code !== 'failover' && code !== 'transfer') return null;
    return { kind: 'host_changed', sid: o['sid'], host, code };
  }
  if (o['kind'] === 'session_state') {
    const state = o['state'];
    if (state !== 'live' && state !== 'paused' && state !== 'ended' && state !== 'expired')
      return null;
    return { kind: 'session_state', sid: o['sid'], state };
  }
  return null;
}

const relayModule: RelayModule = {
  name: 'control',
  order: STAGE_ORDER.control,
  register(ctx) {
    const rooms = roomsFor(ctx);
    // The relay's client reaches every table; the control tables are typed in @centcom/db.
    const db = ctx.db as unknown as ControlDb;
    const mutes = createMuteRegistry({
      store: createPostgresMuteStore(db),
      clock: ctx.clock,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    const policies = createPostgresPolicyStore(db);
    const connections = createConnections({
      rooms: rooms.registry,
      kv: ctx.redis.kv,
      membership: rooms.membership,
      cluster: () => ctx.cluster,
      logger: ctx.log,
    });
    const sequencer: SequencerPort = {
      async emit(sid, frame) {
        const fanout = ctx.fanout;
        if (fanout === undefined) throw new Error('control: the relay has no fan-out');
        return (await fanout.emitServer(sid, frame.kind, frame.t, frame.p)).seq;
      },
      async emitWithRotation(sid, memberLeft) {
        const epoch = ctx.epoch;
        if (epoch === undefined) throw new Error('control: the relay has no key epochs');
        const rotation = await epoch.rotate(sid, 'member_removed', { after: memberLeft });
        return { seqs: [rotation.seq - 1, rotation.seq], kid: rotation.kid };
      },
    };
    const handler = createControlHandler({
      membership: createPostgresMembershipPort(ctx.db),
      sessions: createPostgresSessionState(ctx.db),
      sequencer,
      connections,
      mutes,
      policies,
      audit: rooms.audit,
      onHostChanged(sid) {
        ctx.queue?.onHostChanged(sid).catch(() => undefined);
      },
      onEnded(sid) {
        mutes.forget(sid);
        ctx.presence?.endSession(sid).catch(() => undefined);
      },
      clock: ctx.clock,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    rooms.setMuteState(mutes);
    rooms.setDeniedAuditor((denial) => {
      if (!isClientControlKind(denial.kind)) return false;
      const frame = denial.frame as { p?: unknown };
      handler.auditDenied(
        denial.sid,
        {
          id: denial.member.id,
          userId: denial.member.userId,
          workspaceId: denial.member.workspaceId,
        },
        denial.kind,
        frame.p,
      );
      return true;
    });
    ctx.pipeline.use(STAGE_ORDER.control, controlStage({ handler, rooms: rooms.registry }));
    connections.start();
    // B106: the API tells the relay about a host change it made or a session state change.
    let stopControl: (() => Promise<void>) | undefined;
    ctx.redis.pubsub
      .subscribe(RELAY_CONTROL_CHANNEL, (message) => {
        const command = parseControlCommand(message);
        if (command === null) {
          ctx.metrics.counter('relay_api_control_total', { result: 'invalid' }).inc();
          return;
        }
        const frame =
          command.kind === 'host_changed'
            ? {
                kind: 'control.host_changed',
                t: 'control' as const,
                p: { host: command.host, code: command.code },
              }
            : { kind: 'control.session_state', t: 'control' as const, p: { state: command.state } };
        sequencer.emit(command.sid, frame).then(
          () => {
            ctx.metrics.counter('relay_api_control_total', { result: 'emitted' }).inc();
            if (command.kind === 'host_changed')
              ctx.queue?.onHostChanged(command.sid).catch(() => undefined);
          },
          () => ctx.metrics.counter('relay_api_control_total', { result: 'failed' }).inc(),
        );
      })
      .then(
        (off) => {
          stopControl = async () => off();
        },
        (err: unknown) =>
          ctx.log.warn(
            { error: err instanceof Error ? err.name : typeof err },
            'relay.control_subscribe_failed',
          ),
      );
    ctx.control = { policies, mutes };
    ctx.onShutdown(async () => {
      connections.stop();
      await stopControl?.().catch(() => undefined);
    });
    return undefined;
  },
};

export default relayModule;
