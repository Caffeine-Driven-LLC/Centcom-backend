/**
 * The envelope codec (B039, CT-WS-ENVELOPE): turns a client's text message into a frame the later
 * stages can trust, and frames into canonical JSON.
 *
 * `decodeFrame`, in this order (the size check runs before anything is parsed):
 * 1. binary messages and anything over 256 KiB are refused (`invalid_frame`, `frame_too_large`);
 * 2. bytes must be UTF-8 and JSON nested at most 16 deep (checked on the text, before parsing);
 * 3. unknown top-level fields are dropped, and the server-set `from`, `ts` and `seq` are removed:
 *    a client never supplies them;
 * 4. the frame must pass the generated validators (`envelope.schema.json`, then
 *    `events.schema.json`, which checks each kind's clear/encrypted/hybrid mode); an unknown
 *    kind under a known `t` passes untouched, an unknown `t` does not;
 * 5. `ct` at most 192 KiB serialised and `queue.submit.p.size` at most 192 KiB
 *    (`frame_too_large`); `sid` must be the connection's session.
 *
 * Refusals carry a JSON pointer to the field, never its value. `ct` is measured, never read.
 *
 * Owns: decoding and encoding. Must not: parse or log `ct`, trust a client's `from`, or throw.
 */
import { validateEnvelope, type Envelope } from '@centcom/contracts';

/** CT-WS-ENVELOPE limits. */
export const FRAME_LIMITS = Object.freeze({
  /** Largest text message, in UTF-8 bytes (256 KiB). */
  maxFrameBytes: 262_144,
  /** Largest serialised `ct` (192 KiB). */
  maxCtBytes: 196_608,
  /** Deepest JSON nesting. */
  maxDepth: 16,
  /** Invalid frames a connection may send in 60 s before close 4400. */
  invalidPerMinute: 10,
});

/** The envelope's fields, in canonical order. */
export const ENVELOPE_FIELDS = [
  'v',
  't',
  'id',
  'sid',
  'from',
  'ts',
  'seq',
  'ack',
  'ref',
  'k',
  'p',
  'ct',
  'sig',
] as const satisfies readonly (keyof Envelope)[];

/** Fields only the server sets (CT-WS-ENVELOPE): removed from every client frame. */
export const SERVER_SET_FIELDS: ReadonlySet<string> = new Set(['from', 'ts', 'seq']);

/** A frame from a client, after decoding: no server-set fields. */
export type InboundFrame = Omit<Envelope, 'from' | 'ts' | 'seq'>;
/** A frame the relay sends. */
export type OutboundFrame = Envelope;

/** Why a message was refused, and where. */
export type DecodeFailure = {
  ok: false;
  code: 'invalid_frame' | 'frame_too_large';
  /** JSON pointer to the offending field ('' for the whole frame). */
  pointer?: string;
};

const CLIENT_FIELDS = ENVELOPE_FIELDS.filter((field) => !SERVER_SET_FIELDS.has(field));
const utf8 = new TextDecoder('utf-8', { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when `text`, read as JSON, nests objects and arrays deeper than `max` (strings skipped).
 *
 * String contents are skipped with native `indexOf` rather than walked character by character:
 * a large frame is almost all string (`ct.c`, padding), and walking it in JS dominated decode
 * time. A string ends at the next `"` not escaped by an odd run of backslashes. An unterminated
 * string answers false: `JSON.parse` refuses it anyway.
 */
export function nestsDeeperThan(text: string, max: number): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x22) {
      let end = text.indexOf('"', i + 1);
      while (end !== -1) {
        let slashes = 0;
        for (let k = end - 1; text.charCodeAt(k) === 0x5c; k -= 1) slashes += 1;
        if (slashes % 2 === 0) break;
        end = text.indexOf('"', end + 1);
      }
      if (end === -1) return false;
      i = end;
    } else if (ch === 0x7b || ch === 0x5b) {
      depth += 1;
      if (depth > max) return true;
    } else if (ch === 0x7d || ch === 0x5d) {
      depth -= 1;
    }
  }
  return false;
}

const fail = (code: DecodeFailure['code'], pointer = ''): DecodeFailure => ({
  ok: false,
  code,
  pointer,
});

/**
 * Decodes one client message for the connection of session `sid` (null before the session is
 * known). Never throws.
 */
export function decodeFrame(
  raw: string | Buffer,
  isBinary: boolean,
  sid: string | null,
): { ok: true; frame: InboundFrame } | DecodeFailure {
  try {
    if (isBinary) return fail('invalid_frame');
    let text: string;
    if (typeof raw === 'string') {
      if (Buffer.byteLength(raw, 'utf8') > FRAME_LIMITS.maxFrameBytes)
        return fail('frame_too_large');
      text = raw;
    } else {
      if (raw.length > FRAME_LIMITS.maxFrameBytes) return fail('frame_too_large');
      try {
        text = utf8.decode(raw);
      } catch {
        return fail('invalid_frame');
      }
    }
    if (nestsDeeperThan(text, FRAME_LIMITS.maxDepth)) return fail('invalid_frame');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail('invalid_frame');
    }
    if (!isRecord(parsed)) return fail('invalid_frame');

    const frame: Record<string, unknown> = {};
    for (const field of CLIENT_FIELDS) {
      if (Object.hasOwn(parsed, field)) frame[field] = parsed[field];
    }
    const valid = validateEnvelope(frame);
    if (!valid.ok) return fail('invalid_frame', valid.errors[0]?.pointer ?? '');

    if (
      frame['ct'] !== undefined &&
      Buffer.byteLength(JSON.stringify(frame['ct']), 'utf8') > FRAME_LIMITS.maxCtBytes
    ) {
      return fail('frame_too_large', '/ct');
    }
    const p = frame['p'];
    if (
      frame['k'] === 'queue.submit' &&
      isRecord(p) &&
      typeof p['size'] === 'number' &&
      p['size'] > FRAME_LIMITS.maxCtBytes
    ) {
      return fail('frame_too_large', '/p/size');
    }
    if (sid !== null && frame['sid'] !== undefined && frame['sid'] !== sid) {
      return fail('invalid_frame', '/sid');
    }
    return { ok: true, frame: frame as InboundFrame };
  } catch {
    return fail('invalid_frame');
  }
}

/** A frame as canonical JSON: the envelope's fields only, in canonical order. */
export function encodeFrame(frame: OutboundFrame | InboundFrame): string {
  const source = frame as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const field of ENVELOPE_FIELDS) {
    if (source[field] !== undefined) ordered[field] = source[field];
  }
  return JSON.stringify(ordered);
}
