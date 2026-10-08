/**
 * Frames (B011): the CT-WS-ENVELOPE frame, the protocol constants the simulator and the loopback
 * relay share, and builders for client frames: client-generated `msg_` ids, the frame type and
 * payload mode each kind has in CT-WS-SESSION-EVENTS, opaque ciphertext (random bytes) and a dummy
 * signature for `ct` frames.
 *
 * Owns: building and checking client frames. Must not: set the server-owned fields `from`, `ts`
 * and `seq`, or produce anything that could pass for real cryptography (CT-CRYPTO is the client's):
 * ciphertext here is random bytes under a fixed key id, and signatures are random bytes too.
 */
import { randomBytes } from 'node:crypto';
import {
  EVENT_CATALOGUE,
  isEventKind,
  validateEnvelope,
  type Envelope,
  type ValidationIssue,
} from '@centcom/contracts';

/** A WebSocket frame (CT-WS-ENVELOPE). Extra fields a newer peer adds are kept. */
export type Frame = Envelope;
/** The encrypted part of a frame. */
export type Ciphertext = NonNullable<Envelope['ct']>;
/** Frame types that carry a kind. */
export type KindFrameType = 'event' | 'queue' | 'control' | 'presence';
/** How a kind carries its payload (CT-WS-SESSION-EVENTS). */
export type PayloadMode = 'clear' | 'encrypted' | 'hybrid';

/** Protocol major version (`v`) and the only one the simulator offers by default. */
export const PROTOCOL_VERSION = 1;
/** The WebSocket subprotocol. */
export const SUBPROTOCOL = 'centcom.v1';
/** The largest frame, in bytes of JSON text (256 KiB). */
export const MAX_FRAME_BYTES = 256 * 1024;
/** Fields only the server sets. */
export const SERVER_FIELDS = ['from', 'ts', 'seq'] as const;
/** Frame types the server sequences, buffers and replays. */
export const SEQUENCED_TYPES: ReadonlySet<string> = new Set(['event', 'queue', 'control']);

/** The contract's defaults (CT-WS-ENVELOPE), shared by SimClient and LoopbackRelay. */
export const PROTOCOL_DEFAULTS = Object.freeze({
  /** The server pings this often. */
  pingMs: 20_000,
  /** Either side closes a connection that has been silent this long. */
  deadMs: 50_000,
  /** `sys.hello` must arrive this soon after the upgrade (else close 4408). */
  helloTimeoutMs: 5_000,
  /** A client acks after this many sequenced frames... */
  ackEveryFrames: 64,
  /** ...and at least this often while it holds unacked frames. */
  ackIntervalMs: 5_000,
});

/** True for frame types that carry a server `seq`. */
export const isSequencedType = (t: unknown): boolean =>
  typeof t === 'string' && SEQUENCED_TYPES.has(t);

/** The frame type of a kind: the catalogue's, or the kind's family (`queue.*`, ...) for unknown kinds. */
export function frameTypeOf(kind: string): KindFrameType {
  if (isEventKind(kind)) return EVENT_CATALOGUE[kind].t;
  const family = kind.slice(0, kind.indexOf('.'));
  return family === 'queue' || family === 'control' || family === 'presence' ? family : 'event';
}

/** The payload mode of a kind; unknown kinds count as clear. */
export function payloadModeOf(kind: string): PayloadMode {
  return isEventKind(kind) ? EVENT_CATALOGUE[kind].mode : 'clear';
}

/** A source of random bytes; the CSPRNG by default, a seeded one for repeatable tests. */
export type Bytes = (n: number) => Uint8Array;

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** Opaque ciphertext: random bytes in the CT-CRYPTO shape. Nothing is encrypted. */
export function opaqueCiphertext(bytes: Bytes = randomBytes, size = 48): Ciphertext {
  return {
    alg: 'xchacha20poly1305',
    kid: 'k1',
    n: toBase64Url(bytes(24)),
    c: toBase64Url(bytes(size)),
  };
}

/** A dummy signature: 64 random bytes, base64url (the shape of an Ed25519 signature, not one). */
export function dummySignature(bytes: Bytes = randomBytes): string {
  return toBase64Url(bytes(64));
}

/** A copy of `frame` without `from`, `ts` and `seq`. */
export function withoutServerFields<T extends object>(frame: T): T {
  const fields: ReadonlySet<string> = new Set(SERVER_FIELDS);
  return Object.fromEntries(Object.entries(frame).filter(([key]) => !fields.has(key))) as T;
}

/** The size of a frame on the wire, in bytes. */
export const frameBytes = (data: string): number => Buffer.byteLength(data, 'utf8');

/** A frame that does not validate against the envelope (and the events rules of its kind). */
export class FrameError extends Error {
  constructor(
    message: string,
    readonly issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
  }
}
Object.defineProperty(FrameError.prototype, 'name', {
  value: 'FrameError',
  writable: true,
  configurable: true,
});

/** One line per validation issue: `/p/state is invalid; /id is required`. */
export const describeIssues = (issues: readonly ValidationIssue[]): string =>
  issues.map((issue) => `${issue.pointer || '/'} ${issue.detail}`).join('; ');

/** Throws a FrameError unless `frame` validates (envelope, then the rules of its kind). */
export function checkFrame(frame: unknown): asserts frame is Frame {
  const result = validateEnvelope(frame);
  if (!result.ok) {
    throw new FrameError(
      `the frame does not validate: ${describeIssues(result.errors)}`,
      result.errors,
    );
  }
}

/** Options for `buildFrame`. */
export interface BuildFrameOptions {
  /** The session (`ses_…`). */
  sid: string;
  /** The client-generated id (`msg_…`). */
  id: string;
  /** The frame type; default the kind's (`frameTypeOf`). */
  type?: KindFrameType;
  /** Attach opaque ciphertext and a dummy signature; default: when the kind is encrypted or hybrid. */
  ct?: boolean;
  /** Random bytes for the ciphertext and signature. */
  bytes?: Bytes;
}

/** A client frame of `kind`: `{v, t, id, sid, k}`, `p` when given, `ct` and `sig` as the kind needs. */
export function buildFrame(
  kind: string,
  p: Record<string, unknown> | undefined,
  opts: BuildFrameOptions,
): Frame {
  const frame: Frame = {
    v: 1,
    t: opts.type ?? frameTypeOf(kind),
    id: opts.id,
    sid: opts.sid,
    k: kind,
  };
  if (p !== undefined) frame.p = p;
  if (opts.ct ?? payloadModeOf(kind) !== 'clear') {
    frame.ct = opaqueCiphertext(opts.bytes);
    frame.sig = dummySignature(opts.bytes);
  }
  return frame;
}
