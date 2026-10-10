/**
 * The rooms of one relay (B043): everything the handshake module (order 15) and the rooms module
 * (order 20) share for one `RelayContext`, made on first use. The handshake takes `access` (B038's
 * `SessionAccess`, Postgres) and `onAdmitted` (the room join); the rooms module adds the authorise
 * stage and the membership listener. Keyed by the context, so two relays in one process (tests)
 * never share rooms. B051's control module registers later and plugs in its mutes
 * (`setMuteState`) and its audit of refused control frames (`setDeniedAuditor`).
 *
 * Owns: assembling the parts. Must not: keep anything outside the context's lifetime.
 */
import { createAuditEmitter, type AuditEmitter } from '@centcom/core';
import { createSessionSlotStore, type createDb, type SessionSlotDatabase } from '@centcom/db';
import type { SessionAccess } from '../handshake/access.js';
import type { RelayContext } from '../modules.js';
import { createSlotService } from '../slots/index.js';
import { createPostgresSessionAccess, type AccessDbClient } from './access.js';
import { createRooms, type FrameDenial } from './authorise.js';
import { noMutes, type MuteState } from './kind-policy.js';
import { createPostgresMembership, LiveMembership } from './membership.js';
import { createRoomRegistry, type RoomRegistry } from './registry.js';

/** One relay's rooms. */
export interface RoomsRuntime {
  registry: RoomRegistry;
  membership: LiveMembership;
  mute: MuteState;
  /** B038's port, over Postgres. */
  access: SessionAccess;
  /** Writes the `permission.denied` events of refused frames. */
  audit: AuditEmitter;
  rooms: ReturnType<typeof createRooms>;
  /** B051: the mutes the authorise stage reads from now on (default: nobody is muted). */
  setMuteState(state: MuteState): void;
  /** B051: told of forbidden frames first; true when it audited the frame itself. */
  setDeniedAuditor(auditor: (denial: FrameDenial) => boolean): void;
}

const runtimes = new WeakMap<RelayContext, RoomsRuntime>();

/** The rooms of `ctx`'s relay, made on the first call. */
export function roomsFor(ctx: RelayContext): RoomsRuntime {
  const existing = runtimes.get(ctx);
  if (existing !== undefined) return existing;
  const registry = createRoomRegistry();
  const membership = new LiveMembership({
    source: createPostgresMembership(ctx.db),
    clock: ctx.clock,
  });
  // B051 keeps mutes (its module registers after this runtime is made); until then nobody is.
  const hooks: { mute: MuteState; denied?: (denial: FrameDenial) => boolean } = { mute: noMutes };
  const mute: MuteState = {
    isMuted: (sid, memberId) => hooks.mute.isMuted(sid, memberId),
    ready: (sid) => hooks.mute.ready?.(sid),
  };
  const audit = createAuditEmitter({
    db: ctx.db,
    logger: ctx.log,
    metrics: ctx.metrics,
    clock: ctx.clock,
  });
  const access = createPostgresSessionAccess({
    // The access reads the entitlement tables too; the relay's client reaches every table.
    db: ctx.db as unknown as AccessDbClient,
    membership,
    slots: createSlotService(
      createSessionSlotStore(ctx.db as unknown as ReturnType<typeof createDb<SessionSlotDatabase>>),
    ),
    rooms: registry,
    clock: ctx.clock,
  });
  const rooms = createRooms({
    registry,
    membership,
    mute,
    audit,
    onDenied: (denial) => hooks.denied?.(denial) ?? false,
    logger: ctx.log,
    metrics: ctx.metrics,
  });
  const runtime: RoomsRuntime = {
    registry,
    membership,
    mute,
    access,
    audit,
    rooms,
    setMuteState(state) {
      hooks.mute = state;
    },
    setDeniedAuditor(auditor) {
      hooks.denied = auditor;
    },
  };
  runtimes.set(ctx, runtime);
  return runtime;
}
