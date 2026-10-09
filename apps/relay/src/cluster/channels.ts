/**
 * The cluster's Redis channels and messages (B045). Channels and keys live under the backend's
 * `ct:<env>:` namespace:
 *
 * - `relay:{sid}:frames`: each sequenced frame of the session, `{node, sid, frame}`; `frame` is the
 *   frame exactly as B041 stored it (ciphertext opaque).
 * - `relay:{sid}:eph`: the session's ephemeral frames (presence), `{node, sid, frame}`; never
 *   buffered, logged durably or replayed.
 * - `relay:member:{mid}:ctl`: commands for a member's connections on every node,
 *   `{node, mid, cmd: {code, bye?, device?, before?}}`.
 * - `relay:node:{id}`: each node's heartbeat (15 s TTL), for diagnostics.
 *
 * Messages are parsed defensively (only the relay publishes on these channels, but a node never
 * trusts a malformed one) and never logged.
 *
 * Owns: names and shapes. Must not: carry anything but what a receiver needs.
 */
import type { ErrorCode } from '@centcom/core';
import { isCloseCode, type CloseCodeValue } from '../close-codes.js';
import { closeCodeFor } from '../connection/close.js';
import { SEQUENCED_TYPES, type StoredFrame } from '../seq/types.js';

export const framesChannel = (sid: string): string => `relay:${sid}:frames`;
export const ephemeralChannel = (sid: string): string => `relay:${sid}:eph`;
export const controlChannel = (mid: string): string => `relay:member:${mid}:ctl`;
export const nodeKey = (nodeId: string): string => `relay:node:${nodeId}`;

/** A command for a member's connections (`MemberControl.closeMember`). */
export interface MemberCommand {
  /** The close code (CT-WS-ENVELOPE). */
  code: number;
  /** The `sys.bye` reason, for codes closed with a bye (1001, 4409; optional for 1000). */
  bye?: string;
  /** Only the connections of this device (`dev_…`), as a supersede. */
  device?: string;
  /** Only connections opened before this time (ms since the epoch), so the newest one stays. */
  before?: number;
  /** The `sys.error` code, for codes closed with an error; its close code must be `code`. */
  error?: ErrorCode;
}

/** A frame message as published. */
export interface FrameMessage {
  node: string;
  sid: string;
  frame: StoredFrame;
}

/** A control message as published. */
export interface ControlMessage {
  node: string;
  mid: string;
  cmd: MemberCommand;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const BYE = /^[a-z_]{1,32}$/;

/** JSON of `value`, or undefined when it is not JSON. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A sequenced frame message of session `sid`, or null for anything else. */
export function parseFrameMessage(text: string, sid: string): FrameMessage | null {
  const m = parse(text);
  if (!isRecord(m) || typeof m['node'] !== 'string' || m['sid'] !== sid) return null;
  const f = m['frame'];
  if (
    !isRecord(f) ||
    f['sid'] !== sid ||
    typeof f['t'] !== 'string' ||
    !SEQUENCED_TYPES.has(f['t']) ||
    typeof f['id'] !== 'string' ||
    typeof f['from'] !== 'string' ||
    typeof f['ts'] !== 'string' ||
    typeof f['seq'] !== 'number' ||
    !Number.isSafeInteger(f['seq']) ||
    f['seq'] < 1
  ) {
    return null;
  }
  return { node: m['node'], sid, frame: f as unknown as StoredFrame };
}

/** An ephemeral message of session `sid`, or null for anything else. */
export function parseEphemeralMessage(
  text: string,
  sid: string,
): { node: string; frame: Record<string, unknown> } | null {
  const m = parse(text);
  if (!isRecord(m) || typeof m['node'] !== 'string' || m['sid'] !== sid) return null;
  const f = m['frame'];
  if (!isRecord(f) || typeof f['t'] !== 'string' || SEQUENCED_TYPES.has(f['t'])) return null;
  return { node: m['node'], frame: f };
}

/** A valid command, or null. */
export function checkCommand(cmd: unknown): (MemberCommand & { code: CloseCodeValue }) | null {
  if (!isRecord(cmd)) return null;
  const { code, bye, device, before, error } = cmd;
  if (typeof code !== 'number' || !isCloseCode(code)) return null;
  if (bye !== undefined && (typeof bye !== 'string' || !BYE.test(bye))) return null;
  if (
    device !== undefined &&
    (typeof device !== 'string' || !/^dev_[0-9A-HJKMNP-TV-Z]{26}$/.test(device))
  ) {
    return null;
  }
  if (before !== undefined && (typeof before !== 'number' || !Number.isFinite(before))) return null;
  if (
    error !== undefined &&
    (typeof error !== 'string' || closeCodeFor(error as ErrorCode) !== code)
  ) {
    return null;
  }
  return {
    code,
    ...(bye === undefined ? {} : { bye }),
    ...(device === undefined ? {} : { device }),
    ...(before === undefined ? {} : { before }),
    ...(error === undefined ? {} : { error: error as ErrorCode }),
  };
}

/** A control message for member `mid`, or null. */
export function parseControlMessage(text: string, mid: string): ControlMessage | null {
  const m = parse(text);
  if (!isRecord(m) || typeof m['node'] !== 'string' || m['mid'] !== mid) return null;
  const cmd = checkCommand(m['cmd']);
  return cmd === null ? null : { node: m['node'], mid, cmd };
}
