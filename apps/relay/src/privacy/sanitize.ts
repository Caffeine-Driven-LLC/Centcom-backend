/**
 * The clear payload of a frame, as the relay may carry it (B050, CT-WS-SESSION-EVENTS privacy
 * budget): for a catalogued kind, only the fields of its cleartext column, in the order they came
 * (an encrypted kind keeps none); anything else is dropped. An unknown kind's `p` is not the
 * relay's to judge: it is carried as it came (and never logged).
 *
 * Owns: the rule. Must not: copy a field the catalogue does not list.
 */
import { EVENT_CATALOGUE } from '@centcom/contracts';

/** A clear payload larger than this (serialised) is refused (card B050). */
export const MAX_CLEAR_BYTES = 8_192;
/** Kinds only the server builds, which may be larger (a full queue, a full roster). */
export const SERVER_BUILT: ReadonlySet<string> = new Set(['queue.state', 'control.roster']);

type Entry = { mode: string; clearFields: readonly string[] };
const catalogue = EVENT_CATALOGUE as Record<string, Entry>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The catalogue's entry for `kind`, if it knows it. */
export const catalogued = (kind: string): Entry | undefined =>
  Object.hasOwn(catalogue, kind) ? catalogue[kind] : undefined;

/**
 * The card's function: `p` of a catalogued kind with only its clear fields (`{}` for an encrypted
 * kind), or `{ok: false}` for an unknown kind or a `p` that is not an object. `dropped` names the
 * fields removed (for the violation count; never logged).
 */
export function sanitizeClearPayload(
  kind: string,
  p: unknown,
): { ok: true; p: Record<string, unknown>; dropped: number } | { ok: false } {
  const entry = catalogued(kind);
  if (entry === undefined || !isRecord(p)) return { ok: false };
  const allowed = entry.mode === 'encrypted' ? [] : entry.clearFields;
  const kept: Record<string, unknown> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(p)) {
    if (allowed.includes(key)) kept[key] = value;
    else dropped += 1;
  }
  return { ok: true, p: dropped === 0 ? p : kept, dropped };
}

/** The serialised size of a clear payload, in bytes. */
export const clearBytes = (p: unknown): number =>
  Buffer.byteLength(JSON.stringify(p) ?? '', 'utf8');
