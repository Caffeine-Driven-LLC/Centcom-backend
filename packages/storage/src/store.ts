/**
 * The durable history store (B055, CT-RESUME): a session's sequenced ciphertext frames, batched
 * into blobs, with an index in Postgres that holds only what CT-RESUME lets the server keep.
 *
 * - **What is kept** (`toStoredFrame`): `event`, `queue` and `control` frames only; `presence`,
 *   `sys.*` and acks never. For an encrypted kind `p` must be empty (a frame that carries one is
 *   refused: it could hold plaintext); for clear and hybrid kinds only the contract's clear fields
 *   of `p` are kept; for a kind the catalogue does not know, only `ct`. `ct` is kept as received.
 * - **append**: frames already indexed are skipped (idempotent on `(sid, seq)`); the rest are
 *   written as one blob (`history/<sid>/<first>-<last>.bin`), then indexed with
 *   `ON CONFLICT DO NOTHING`. A crash between the two leaves a blob nobody points at; `repair`
 *   indexes it (once: the conflict rule keeps rows unique), and a retried append rewrites the same
 *   key.
 * - **read**: up to `limit` frames from the first one after `afterSeq` (or the earliest retained
 *   one, when older frames are gone), stopping at the first gap: only contiguous data is
 *   returned. Every blob of the page must be read, or the read fails (never a partial page).
 * - **purge**: for each blob, delete the blob, then its index rows; then the retention row. A
 *   failure leaves the rest for a retry, and reads in between see only frames not yet deleted.
 *
 * Owns: the log's layout and rules. Must not: decode, normalise or log `ct`, keep a field the
 * contract does not allow, or put user text in a key.
 */
import { EVENT_CATALOGUE, isId } from '@centcom/contracts';
import type { HistoryDatabase } from '@centcom/db';
import { sql, type Kysely } from 'kysely';
import {
  BATCH_CONTENT_TYPE,
  decodeBatch,
  encodeBatch,
  historyBlobKey,
  historyPrefix,
  parseBlobKey,
  type BlobStore,
} from './blob-store.js';
import type { CtObject, HistoryRead, HistoryStore, KindClass, StoredFrame } from './ports.js';

/** Index rows written per statement. */
const INSERT_CHUNK = 500;

/** Why a frame is not stored. */
export type RejectReason = 'ephemeral' | 'invalid' | 'encrypted_with_p';

/** A sequenced frame as the relay hands it over (the envelope after sequencing). */
export interface SequencedFrame {
  t: string;
  id?: unknown;
  from?: unknown;
  ts?: unknown;
  seq?: unknown;
  ref?: unknown;
  k?: unknown;
  p?: unknown;
  ct?: unknown;
  sig?: unknown;
}

const KEPT_TYPES: ReadonlySet<string> = new Set(['event', 'queue', 'control']);
const FRAME_ID = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/;
const SIG = /^[A-Za-z0-9_-]+$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCt = (v: unknown): v is CtObject =>
  isRecord(v) &&
  typeof v['alg'] === 'string' &&
  typeof v['kid'] === 'string' &&
  typeof v['n'] === 'string' &&
  typeof v['c'] === 'string';

/** The catalogue's entry for kind `k`, if it knows it. */
const catalogued = (k: string): { mode: string; clearFields: readonly string[] } | undefined =>
  (EVENT_CATALOGUE as Record<string, { mode: string; clearFields: readonly string[] }>)[k];

/** The frame the log keeps of `frame`, or why it keeps none (see the module comment). */
export function toStoredFrame(
  frame: SequencedFrame,
): { ok: true; frame: StoredFrame } | { ok: false; reason: RejectReason } {
  if (!KEPT_TYPES.has(frame.t)) return { ok: false, reason: 'ephemeral' };
  const { id, from, ts, seq, ref, k, p, ct, sig } = frame;
  if (
    typeof id !== 'string' ||
    !FRAME_ID.test(id) ||
    typeof from !== 'string' ||
    (from !== 'srv' && !isId('mem', from)) ||
    typeof ts !== 'string' ||
    Number.isNaN(Date.parse(ts)) ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    (ref !== undefined && (typeof ref !== 'string' || !FRAME_ID.test(ref))) ||
    (k !== undefined && typeof k !== 'string') ||
    (ct !== undefined && !isCt(ct)) ||
    (p !== undefined && !isRecord(p)) ||
    (sig !== undefined && (typeof sig !== 'string' || !SIG.test(sig)))
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const entry = typeof k === 'string' ? catalogued(k) : undefined;
  let kept: Record<string, unknown> | null = null;
  if (entry?.mode === 'encrypted') {
    if (p !== undefined && Object.keys(p).length > 0)
      return { ok: false, reason: 'encrypted_with_p' };
  } else if (entry !== undefined && p !== undefined) {
    // Clear and hybrid kinds: the contract's clear fields, nothing else.
    kept = Object.fromEntries(Object.entries(p).filter(([key]) => entry.clearFields.includes(key)));
  }
  const stored: StoredFrame = {
    seq,
    id,
    from,
    ts,
    kindClass: frame.t as KindClass,
    ...(typeof ref === 'string' ? { ref } : {}),
    ...(typeof k === 'string' ? { k } : {}),
    size: 0,
    kid: ct === undefined ? null : ct.kid,
    ct: ct ?? null,
    p: kept,
    ...(typeof sig === 'string' ? { sig } : {}),
  };
  return { ok: true, frame: stored };
}

/** What the store needs. */
export interface HistoryStoreDeps {
  db: Kysely<HistoryDatabase>;
  blobs: BlobStore;
}

/** The Postgres-and-blob history store, plus crash repair. */
export function createHistoryStore(
  deps: HistoryStoreDeps,
): HistoryStore & { repair(sid: string): Promise<{ indexed: number }> } {
  const { db, blobs } = deps;

  async function indexFrames(sid: string, key: string, frames: readonly StoredFrame[]) {
    for (let i = 0; i < frames.length; i += INSERT_CHUNK) {
      const chunk = frames.slice(i, i + INSERT_CHUNK);
      await db
        .insertInto('history_index')
        .values(
          chunk.map((f) => ({
            session_id: sid,
            seq: f.seq,
            msg_id: f.id,
            member_id: f.from,
            ts: f.ts,
            kind_class: f.kindClass,
            size: f.size,
            kid: f.kid,
            blob_key: key,
          })),
        )
        .onConflict((oc) => oc.columns(['session_id', 'seq']).doNothing())
        .execute();
    }
  }

  async function indexedSeqs(sid: string, seqs: readonly number[]): Promise<Set<number>> {
    if (seqs.length === 0) return new Set();
    const rows = await db
      .selectFrom('history_index')
      .select('seq')
      .where('session_id', '=', sid)
      .where('seq', 'in', seqs.map(String))
      .execute();
    return new Set(rows.map((r) => Number(r.seq)));
  }

  return {
    async append(sid, frames) {
      if (!isId('ses', sid)) throw new TypeError('append: sid must be a ses_ id');
      if (frames.length === 0) return { lastSeq: 0 };
      const bySeq = new Map<number, StoredFrame>();
      for (const f of frames) if (!bySeq.has(f.seq)) bySeq.set(f.seq, f);
      const lastSeq = Math.max(...bySeq.keys());
      const known = await indexedSeqs(sid, [...bySeq.keys()]);
      const fresh = [...bySeq.values()]
        .filter((f) => !known.has(f.seq))
        .sort((a, b) => a.seq - b.seq);
      if (fresh.length === 0) return { lastSeq };
      const first = fresh[0]?.seq ?? 1;
      const last = fresh.at(-1)?.seq ?? first;
      const key = historyBlobKey(sid, first, last);
      const batch = encodeBatch(fresh);
      await blobs.put(key, batch.body, { contentType: BATCH_CONTENT_TYPE });
      await indexFrames(sid, key, batch.frames);
      return { lastSeq };
    },

    async read(sid, afterSeq, limit) {
      const bounds = await db
        .selectFrom('history_index')
        .select([
          sql<string | null>`min(seq)`.as('earliest'),
          sql<string | null>`max(seq)`.as('head'),
        ])
        .where('session_id', '=', sid)
        .executeTakeFirst();
      const earliest = bounds?.earliest == null ? null : Number(bounds.earliest);
      const head = bounds?.head == null ? null : Number(bounds.head);
      const empty: HistoryRead = {
        frames: [],
        nextAfterSeq: null,
        earliestSeq: earliest,
        headSeq: head,
      };
      if (earliest === null) return empty;
      const start = Math.max(afterSeq + 1, earliest);
      const rows = await db
        .selectFrom('history_index')
        .select(['seq', 'blob_key', 'size'])
        .where('session_id', '=', sid)
        .where('seq', '>=', String(start))
        .orderBy('seq')
        .limit(limit + 1)
        .execute();
      // Contiguous data only: stop at the first gap.
      const run: typeof rows = [];
      for (const row of rows) {
        if (Number(row.seq) !== start + run.length) break;
        run.push(row);
      }
      const page = run.slice(0, limit);
      if (page.length === 0) return empty;
      const blobsOfPage = new Map<string, Map<number, StoredFrame>>();
      for (const key of new Set(page.map((r) => r.blob_key))) {
        const frames = decodeBatch(await blobs.get(key));
        blobsOfPage.set(key, new Map(frames.map((f) => [f.seq, f])));
      }
      const out: StoredFrame[] = [];
      for (const row of page) {
        const frame = blobsOfPage.get(row.blob_key)?.get(Number(row.seq));
        if (frame === undefined)
          throw new Error('history: an indexed frame is missing from its blob');
        out.push({ ...frame, size: row.size });
      }
      const more = run.length > limit;
      return {
        frames: out,
        nextAfterSeq: more ? (out.at(-1)?.seq ?? null) : null,
        earliestSeq: earliest,
        headSeq: head,
      };
    },

    async purge(sid) {
      const listed = await blobs.list(historyPrefix(sid));
      const indexed = await db
        .selectFrom('history_index')
        .select('blob_key')
        .distinct()
        .where('session_id', '=', sid)
        .execute();
      const keys = [...new Set([...listed, ...indexed.map((r) => r.blob_key)])].sort();
      let deleted = 0;
      for (const key of keys) {
        // The blob first: a failure here leaves the rows, so a retry finds the blob again.
        await blobs.delete([key]);
        const result = await db
          .deleteFrom('history_index')
          .where('session_id', '=', sid)
          .where('blob_key', '=', key)
          .executeTakeFirst();
        deleted += Number(result.numDeletedRows);
      }
      await db.deleteFrom('history_retention').where('session_id', '=', sid).execute();
      return { deleted, blobs: keys.length };
    },

    async setExpiry(sid, at) {
      await db
        .insertInto('history_retention')
        .values({ session_id: sid, expires_at: at })
        .onConflict((oc) =>
          oc.column('session_id').doUpdateSet({ expires_at: at, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async repair(sid) {
      let indexedCount = 0;
      for (const key of await blobs.list(historyPrefix(sid))) {
        const range = parseBlobKey(key);
        if (range === null || range.sid !== sid) continue;
        const present = await db
          .selectFrom('history_index')
          .select(sql<string>`count(*)`.as('n'))
          .where('session_id', '=', sid)
          .where('blob_key', '=', key)
          .executeTakeFirstOrThrow();
        const frames = decodeBatch(await blobs.get(key));
        if (Number(present.n) >= frames.length) continue;
        const known = await indexedSeqs(
          sid,
          frames.map((f) => f.seq),
        );
        const missing = frames.filter((f) => !known.has(f.seq));
        await indexFrames(sid, key, missing);
        indexedCount += missing.length;
      }
      return { indexed: indexedCount };
    },
  };
}

/**
 * The history side of B027's workspace purge: purges the history of every session of a (deleted)
 * workspace, blobs first, before the purge deletes the sessions (whose rows the history references
 * with ON DELETE RESTRICT). Idempotent: a session without history purges nothing.
 */
export function createWorkspaceHistoryPurger(deps: {
  db: Kysely<HistoryDatabase>;
  store: Pick<HistoryStore, 'purge'>;
}): { purgeWorkspace(workspaceId: string): Promise<{ sessions: number; frames: number }> } {
  return {
    async purgeWorkspace(workspaceId) {
      const sessions = await deps.db
        .selectFrom('sessions')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute();
      let frames = 0;
      for (const { id } of sessions) frames += (await deps.store.purge(id)).deleted;
      return { sessions: sessions.length, frames };
    },
  };
}

/** When a session's history expires: `historyDays` after it ended (0 days: at once). */
export function retentionExpiry(endedAt: Date, historyDays: number): Date {
  return new Date(endedAt.getTime() + Math.max(0, historyDays) * 24 * 60 * 60 * 1000);
}
