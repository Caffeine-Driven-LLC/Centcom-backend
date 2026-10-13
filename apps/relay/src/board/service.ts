/**
 * The shared context board in the relay (B111, CT-WS-SESSION-EVENTS `board.note`, `board.pin`,
 * `board.remove`). The relay never sees a note's text or refs (they are in `ct`); it keeps only
 * what it needs to validate references and limits: for each note its id (the `msg_` id of the
 * `board.note` frame), author, type, pinned and removed flags.
 *
 * - **Who:** host and editor add and pin (viewers are refused earlier, again here); `board.remove`
 *   only by the host or the note's author.
 * - **References:** `board.pin` and `board.remove` must name a live note of this session
 *   (`invalid_frame`); a removed note cannot be pinned or removed again. `supersedes` must name a
 *   note by the same author, unless the host sends it.
 * - **Limits:** 20 notes per member per hour (a sliding window in Redis, shared by the nodes) and
 *   500 live notes per session; over either, `frame_rate_exceeded`, not sequenced.
 * - **Sequencing:** every accepted frame is sequenced unchanged; refusals happen before sequencing
 *   and consume no sequence number. State is recorded after the frame has its `seq`.
 *
 * Owns: these rules and the per-session state. Must not: read `ct`, or log a frame.
 */
import { validateEvent } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  type KeyValue,
  type Metrics,
  type RateLimitStore,
} from '@centcom/core';
import { randomBytes } from 'node:crypto';
import type { StoredFrame } from '../seq/types.js';

/** At most this many `board.note` per member per hour. */
export const NOTES_PER_MEMBER_PER_HOUR = 20;
/** At most this many live (not removed) notes in a session. */
export const MAX_LIVE_NOTES = 500;
/** How long a session's board document is kept after its last change. */
export const BOARD_DOC_TTL_MS = 48 * 3_600_000;

export const BOARD_DETAILS = Object.freeze({
  malformed: 'The frame does not carry a valid board entry.',
  unknownNote: 'That note does not exist in this session (or was removed).',
  notAuthor: 'Only the host or the note’s author may remove it.',
  notYours: 'A note can only replace one of your own.',
  perMember: `You can add at most ${NOTES_PER_MEMBER_PER_HOUR} notes an hour.`,
  perSession: `The board holds at most ${MAX_LIVE_NOTES} notes.`,
  unavailable: 'The board cannot be changed right now; try again shortly.',
  viewer: 'Viewers cannot change the board.',
} as const);

/** A note as the relay keeps it. */
export interface NoteRecord {
  author: string;
  type: 'decision' | 'warning' | 'finding';
  pinned: boolean;
  removed: boolean;
}

/** A frame as the service reads it: ids and the cleartext `p` only. */
export interface BoardFrame {
  id: string;
  k: 'board.note' | 'board.pin' | 'board.remove';
  p: unknown;
}

export interface BoardSender {
  memberId: string;
  role: 'host' | 'editor' | 'viewer';
}

export type BoardResult =
  | { outcome: 'sequenced' }
  | { outcome: 'ignored' }
  | {
      outcome: 'refused';
      code: 'invalid_frame' | 'forbidden' | 'frame_rate_exceeded' | 'service_unavailable';
      detail: string;
    };

/** Where a session's notes are kept. */
export interface BoardStore {
  /** Runs `fn` holding the session's mutex; `load` and `save` the notes inside it. */
  withSession<T>(
    sid: string,
    fn: (tx: {
      load(): Promise<Map<string, NoteRecord>>;
      save(notes: Map<string, NoteRecord>): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
  purge(sid: string): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const unavailable = (): AppError =>
  new AppError('service_unavailable', { detail: BOARD_DETAILS.unavailable, retryAfterS: 1 });

/** A board store over Redis (`relay:board:<sid>`, one JSON document) with a mutex. */
export function createRedisBoardStore(deps: {
  kv: Pick<KeyValue, 'get' | 'set' | 'setIfAbsent' | 'del'>;
  clock?: () => number;
}): BoardStore {
  const clock = deps.clock ?? Date.now;
  const kv = deps.kv;
  const doc = (sid: string): string => `relay:board:${sid}`;
  const mutex = (sid: string): string => `relay:board:${sid}:mutex`;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());
  return {
    async withSession(sid, fn) {
      const token = randomBytes(12).toString('base64url');
      const deadline = clock() + 2_000;
      for (;;) {
        let got: boolean;
        try {
          got = await kv.setIfAbsent(mutex(sid), token, 30_000);
        } catch {
          throw unavailable();
        }
        if (got) break;
        if (clock() >= deadline) throw unavailable();
        await sleep(10);
      }
      try {
        return await fn({
          async load() {
            const text = await kv.get(doc(sid));
            const notes = new Map<string, NoteRecord>();
            if (text === null) return notes;
            try {
              const raw = JSON.parse(text) as {
                v?: number;
                notes?: ({ id: string } & NoteRecord)[];
              };
              if (raw.v === 1)
                for (const n of raw.notes ?? [])
                  notes.set(n.id, {
                    author: n.author,
                    type: n.type,
                    pinned: n.pinned,
                    removed: n.removed,
                  });
            } catch {
              // an unreadable document starts over; the notes themselves stay in the sequenced history
            }
            return notes;
          },
          async save(notes) {
            await kv.set(
              doc(sid),
              JSON.stringify({ v: 1, notes: [...notes].map(([id, n]) => ({ id, ...n })) }),
              { ttlMs: BOARD_DOC_TTL_MS },
            );
          },
        });
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw unavailable();
      } finally {
        try {
          if ((await kv.get(mutex(sid))) === token) await kv.del(mutex(sid));
        } catch {
          // the mutex expires on its own
        }
      }
    },
    async purge(sid) {
      await kv.del(doc(sid));
    },
  };
}

/** A board store in memory (tests). */
export function createMemoryBoardStore(): BoardStore & {
  notes(sid: string): Map<string, NoteRecord>;
} {
  const all = new Map<string, Map<string, NoteRecord>>();
  const chains = new Map<string, Promise<unknown>>();
  return {
    notes: (sid) => all.get(sid) ?? new Map(),
    withSession(sid, fn) {
      const run = async () =>
        fn({
          load: () => Promise.resolve(new Map(all.get(sid) ?? [])),
          save: (notes) => {
            all.set(sid, new Map(notes));
            return Promise.resolve();
          },
        });
      const next = (chains.get(sid) ?? Promise.resolve()).then(run, run);
      chains.set(
        sid,
        next.catch(() => undefined),
      );
      return next;
    },
    purge(sid) {
      all.delete(sid);
      return Promise.resolve();
    },
  };
}

/** The board service. */
export class BoardService {
  readonly #metrics: Metrics;
  readonly #local = new Map<string, number[]>();

  constructor(
    private readonly deps: {
      store: BoardStore;
      rateLimit?: Pick<RateLimitStore, 'consume'>;
      clock?: () => number;
      metrics?: Metrics;
    },
  ) {
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Per member per hour; Redis down: this node's own window takes over. */
  async #allowNote(sid: string, member: string): Promise<boolean> {
    const key = `relay:board:rl:${sid}:${member}`;
    if (this.deps.rateLimit !== undefined) {
      try {
        return (await this.deps.rateLimit.consume(key, NOTES_PER_MEMBER_PER_HOUR, 3_600)).allowed;
      } catch {
        // falls through to the local window
      }
    }
    const now = (this.deps.clock ?? Date.now)();
    const recent = (this.#local.get(key) ?? []).filter((at) => now - at < 3_600_000);
    const ok = recent.length < NOTES_PER_MEMBER_PER_HOUR;
    if (ok) recent.push(now);
    this.#local.set(key, recent);
    return ok;
  }

  #refuse(
    reason: string,
    code: 'invalid_frame' | 'forbidden' | 'frame_rate_exceeded' | 'service_unavailable',
    detail: string,
  ): BoardResult {
    this.#metrics.counter('relay_board_refused_total', { reason }).inc();
    return { outcome: 'refused', code, detail };
  }

  /**
   * Handles one frame. `sequence` runs the rest of the pipeline and answers the stored frame
   * (undefined when sequencing refused it).
   */
  async handle(
    sid: string,
    sender: BoardSender,
    frame: BoardFrame,
    sequence: () => Promise<StoredFrame | undefined>,
  ): Promise<BoardResult> {
    if (sender.role === 'viewer') return this.#refuse('viewer', 'forbidden', BOARD_DETAILS.viewer);
    if (!validateEvent(frame.k, frame.p, { mode: 'tolerant' }).ok || !isRecord(frame.p)) {
      return this.#refuse('malformed', 'invalid_frame', BOARD_DETAILS.malformed);
    }
    const p = frame.p;
    try {
      return await this.deps.store.withSession(sid, async (tx) => {
        const notes = await tx.load();
        if (frame.k === 'board.note') {
          const existing = notes.get(frame.id);
          if (existing !== undefined) {
            // A resend of the same frame by its author: sequenced again (B041 echoes its first seq).
            if (existing.author !== sender.memberId) {
              return this.#refuse('malformed', 'invalid_frame', BOARD_DETAILS.malformed);
            }
            await sequence();
            return { outcome: 'sequenced' } as const;
          }
          const live = [...notes.values()].filter((n) => !n.removed).length;
          if (live >= MAX_LIVE_NOTES) {
            return this.#refuse('session_cap', 'frame_rate_exceeded', BOARD_DETAILS.perSession);
          }
          const supersedes = p['supersedes'];
          if (typeof supersedes === 'string') {
            const old = notes.get(supersedes);
            if (old === undefined || old.removed) {
              return this.#refuse('unknown_note', 'invalid_frame', BOARD_DETAILS.unknownNote);
            }
            if (sender.role !== 'host' && old.author !== sender.memberId) {
              return this.#refuse('not_author', 'forbidden', BOARD_DETAILS.notYours);
            }
          }
          if (!(await this.#allowNote(sid, sender.memberId))) {
            return this.#refuse('member_cap', 'frame_rate_exceeded', BOARD_DETAILS.perMember);
          }
          const stored = await sequence();
          if (stored === undefined) return { outcome: 'ignored' } as const;
          notes.set(frame.id, {
            author: sender.memberId,
            type: p['type'] as NoteRecord['type'],
            pinned: false,
            removed: false,
          });
          if (typeof supersedes === 'string') {
            const old = notes.get(supersedes);
            if (old !== undefined) old.removed = true;
          }
          await tx.save(notes);
          this.#metrics.counter('relay_board_notes_total', { type: String(p['type']) }).inc();
          return { outcome: 'sequenced' } as const;
        }
        const target = typeof p['target'] === 'string' ? notes.get(p['target']) : undefined;
        if (target === undefined || target.removed) {
          return this.#refuse('unknown_note', 'invalid_frame', BOARD_DETAILS.unknownNote);
        }
        if (
          frame.k === 'board.remove' &&
          sender.role !== 'host' &&
          target.author !== sender.memberId
        ) {
          return this.#refuse('not_author', 'forbidden', BOARD_DETAILS.notAuthor);
        }
        const stored = await sequence();
        if (stored === undefined) return { outcome: 'ignored' } as const;
        if (frame.k === 'board.pin') target.pinned = p['pinned'] === true;
        else target.removed = true;
        await tx.save(notes);
        return { outcome: 'sequenced' } as const;
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'service_unavailable') {
        return this.#refuse('unavailable', 'service_unavailable', BOARD_DETAILS.unavailable);
      }
      throw err;
    }
  }

  /** Removes a session's notes (its history was purged). */
  purge(sid: string): Promise<void> {
    return this.deps.store.purge(sid);
  }
}
