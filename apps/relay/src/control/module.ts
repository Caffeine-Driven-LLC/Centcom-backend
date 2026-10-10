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
    ctx.control = { policies, mutes };
    ctx.onShutdown(() => {
      connections.stop();
      return Promise.resolve();
    });
    return undefined;
  },
};

export default relayModule;
