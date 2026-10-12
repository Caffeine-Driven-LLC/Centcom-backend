/**
 * The first-join announcement (CT-WS-CONTROL `control.member_joined`): the first time a member
 * connects to a session, the relay sequences `control.member_joined {member, name, slot, role,
 * device}` from `srv`, so the host learns of the newcomer (to grant the session keys) and every
 * client can show them. A reconnect is not announced; neither is a member the relay already
 * announced, on any node (the marker is on Redis).
 *
 * Owns: the first-join marker and the frame. Must not: fail or delay a welcome (the caller
 * ignores the outcome) or announce a member twice.
 */
import type { KeyValue, Logger } from '@centcom/core';
import type { AdmittedHello } from './handshake.js';

/** How long a member counts as already announced: longer than any session lives. */
export const ANNOUNCED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The marker's key. */
export const announcedKey = (sid: string, mid: string): string => `relay:joined:${sid}:${mid}`;

/** What the announcement needs. */
export interface AnnounceDeps {
  kv: Pick<KeyValue, 'setIfAbsent' | 'del'>;
  /** B044's `emitServer`; undefined on a relay without fan-out (nothing is announced). */
  emitServer:
    | ((sid: string, kind: string, t: 'control', p: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  logger?: Logger;
}

/** Announces the member of `admitted` when this is their first connection. Never throws. */
export async function announceJoin(deps: AnnounceDeps, admitted: AdmittedHello): Promise<void> {
  const { sid, dev, access } = admitted;
  const member = access.member;
  if (deps.emitServer === undefined) return;
  const key = announcedKey(sid, member.id);
  try {
    if (!(await deps.kv.setIfAbsent(key, '1', ANNOUNCED_TTL_MS))) return;
    try {
      await deps.emitServer(sid, 'control.member_joined', 'control', {
        member: member.id,
        name: member.name,
        slot: member.slot,
        role: member.role,
        device: dev,
      });
    } catch (err) {
      // Not announced: the next connection tries again.
      await deps.kv.del(key).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    deps.logger?.warn(
      { sid, error: err instanceof Error ? err.name : typeof err },
      'relay.member_joined_failed',
    );
  }
}
