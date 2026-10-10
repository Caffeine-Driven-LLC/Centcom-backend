/**
 * The command-post queue's state machine (B052, CT-WS-QUEUE "States" and "Rules"): a pure,
 * deterministic reducer over sequenced queue frames, so every node and every client that replays
 * the same frames in `seq` order reaches the same `queue.state`.
 *
 * ```
 *            submit         approve           claim           done
 *  (none) ─────────► queued ───────► approved ───────► running ──────► done | failed | canceled
 *                     │                 │                 │
 *       cancel/reject/drop       drop/cancel        (host loss: approved and running are held)
 *                     ▼                 ▼
 *             canceled|rejected      dropped
 * ```
 *
 * - **Order** comes only from `approve` (appends) and `reorder` frames, never from timestamps. An
 *   item has a `position` (1-based) while it is in the order and still waiting (queued, approved
 *   or held from approved); a queued item never ordered has none.
 * - **Reorder:** the known waiting items it lists come first, in its order; the rest of the order
 *   keeps its relative order after them. Unknown ids are ignored and reported (`gone`).
 * - **Claim:** an approved item, at most once; an agent runs one item at a time.
 * - **Cancel:** the submitter, while queued or approved (held from approved included).
 * - **Host loss** (`host` op): approved and running items become `held`, remembering what they
 *   were; on return they go back. An item approved while the host is away is held at once.
 * - **Version** rises by exactly 1 per accepted change; a refused op changes nothing.
 * - A server `queue.state` met while replaying is a checkpoint: its `version` and its held items are
 *   taken as they are.
 *
 * Owns: transitions, order and the view. Must not: check roles or policy (the service does), or
 * read `ct`.
 */

/** Every item state. */
export type QueueState =
  | 'queued'
  | 'approved'
  | 'running'
  | 'held'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'dropped';

/** States of an item still in the queue (counted by the caps, shown in `queue.state`). */
export const LIVE_STATES: ReadonlySet<QueueState> = new Set([
  'queued',
  'approved',
  'running',
  'held',
]);

/** A queue item, as the relay keeps it (never its body). */
export interface QueueItem {
  /** `que_`. */
  item: string;
  /** `mem_`. */
  submitter: string;
  state: QueueState;
  /** What a held item was before the host left. */
  heldFrom?: 'approved' | 'running';
  /** Ciphertext bytes, as the submit declared. */
  size: number;
  kind: 'message' | 'command';
  /** The submit frame's server timestamp. */
  ts: string;
  /** The agent running it (`agt_`), once claimed. */
  agentId?: string;
  createdSeq: number;
  updatedSeq: number;
}

/** A session's queue. */
export interface QueueModel {
  version: number;
  hostAway: boolean;
  /** Ordered item ids (waiting items only). */
  order: string[];
  items: Map<string, QueueItem>;
}

/** One item in `queue.state` (B052's QueueItemView). */
export interface QueueItemView {
  item: string;
  submitter: string;
  state: QueueState;
  position: number | null;
  size: number;
  kind: 'message' | 'command';
  ts: string;
  agent_id?: string;
}

/** The body of `queue.state`. */
export interface QueueStateBody {
  version: number;
  items: QueueItemView[];
}

/** What a frame asks of the queue. */
export type QueueOp =
  | { k: 'queue.submit'; from: string; item: string; size: number; kind: 'message' | 'command' }
  | { k: 'queue.cancel'; from: string; item: string }
  | { k: 'queue.approve'; item: string }
  | { k: 'queue.reject'; item: string }
  | { k: 'queue.drop'; item: string }
  | { k: 'queue.reorder'; order: string[] }
  | { k: 'queue.claim'; item: string; agentId: string }
  | { k: 'queue.done'; item: string; outcome: 'ok' | 'error' | 'canceled' }
  | { k: 'host'; away: boolean };

/** Why an op was refused. */
export type QueueRefusal = 'duplicate' | 'queue_item_gone' | 'forbidden' | 'conflict';

/** The outcome of an op. */
export type Reduced =
  | {
      ok: true;
      model: QueueModel;
      /** Ids of the items it changed. */
      changed: string[];
      /** A reorder listed ids that are not waiting items. */
      gone: boolean;
    }
  | { ok: false; refusal: QueueRefusal; detail: string };

/** An empty queue. */
export const emptyQueue = (): QueueModel => ({
  version: 0,
  hostAway: false,
  order: [],
  items: new Map(),
});

/** A deep copy (the reducer never changes its input). */
export function cloneQueue(model: QueueModel): QueueModel {
  return {
    version: model.version,
    hostAway: model.hostAway,
    order: [...model.order],
    items: new Map([...model.items].map(([id, item]) => [id, { ...item }])),
  };
}

/** True while `state` waits for its turn (and so may be in the order). */
const waiting = (item: QueueItem): boolean =>
  item.state === 'queued' ||
  item.state === 'approved' ||
  (item.state === 'held' && item.heldFrom === 'approved');

/** True for an approved item, held or not. */
const isApproved = (item: QueueItem): boolean =>
  item.state === 'approved' || (item.state === 'held' && item.heldFrom === 'approved');

/** True for a running item, held or not. */
const isRunning = (item: QueueItem): boolean =>
  item.state === 'running' || (item.state === 'held' && item.heldFrom === 'running');

/** The details of the refusals (GUIDELINES §3.4). */
export const QUEUE_DETAILS = Object.freeze({
  duplicate: 'That item is already in the queue.',
  gone: 'That queue item no longer exists or has finished.',
  notSubmitter: 'Only the member who submitted an item can cancel it.',
  claimed: 'That item is already running.',
  agentBusy: 'That agent is already running an item.',
  state: 'That item is not in a state that allows this.',
} as const);

const refuse = (refusal: QueueRefusal, detail: string): Reduced => ({
  ok: false,
  refusal,
  detail,
});

/** Applies `op`, as the frame at `seq` with timestamp `ts`, to a copy of `model`. */
export function reduce(model: QueueModel, op: QueueOp, seq: number, ts: string): Reduced {
  const next = cloneQueue(model);
  const done = (changed: string[], gone = false): Reduced => {
    next.version += 1;
    for (const id of changed) {
      const item = next.items.get(id);
      if (item !== undefined) item.updatedSeq = seq;
    }
    return { ok: true, model: next, changed, gone };
  };
  const unorder = (id: string) => {
    next.order = next.order.filter((o) => o !== id);
  };
  if (op.k === 'host') {
    if (next.hostAway === op.away) return refuse('conflict', QUEUE_DETAILS.state);
    next.hostAway = op.away;
    const changed: string[] = [];
    for (const item of next.items.values()) {
      if (op.away && (item.state === 'approved' || item.state === 'running')) {
        item.heldFrom = item.state;
        item.state = 'held';
        changed.push(item.item);
      } else if (!op.away && item.state === 'held' && item.heldFrom !== undefined) {
        item.state = item.heldFrom;
        delete item.heldFrom;
        changed.push(item.item);
      }
    }
    return done(changed);
  }
  if (op.k === 'queue.submit') {
    if (next.items.has(op.item)) return refuse('duplicate', QUEUE_DETAILS.duplicate);
    next.items.set(op.item, {
      item: op.item,
      submitter: op.from,
      state: 'queued',
      size: op.size,
      kind: op.kind,
      ts,
      createdSeq: seq,
      updatedSeq: seq,
    });
    return done([op.item]);
  }
  if (op.k === 'queue.reorder') {
    const listed = [...new Set(op.order)];
    const known = listed.filter((id) => {
      const item = next.items.get(id);
      return item !== undefined && waiting(item);
    });
    if (known.length === 0) return refuse('queue_item_gone', QUEUE_DETAILS.gone);
    const rest = next.order.filter((id) => !known.includes(id));
    next.order = [...known, ...rest];
    return done(known, known.length < listed.length);
  }
  const item = next.items.get(op.item);
  if (item === undefined || !LIVE_STATES.has(item.state)) {
    return refuse('queue_item_gone', QUEUE_DETAILS.gone);
  }
  switch (op.k) {
    case 'queue.cancel':
      if (item.submitter !== op.from) return refuse('forbidden', QUEUE_DETAILS.notSubmitter);
      if (!(item.state === 'queued' || isApproved(item))) {
        return refuse('conflict', QUEUE_DETAILS.state);
      }
      item.state = 'canceled';
      delete item.heldFrom;
      unorder(item.item);
      return done([item.item]);
    case 'queue.approve':
      if (item.state !== 'queued') return refuse('conflict', QUEUE_DETAILS.state);
      if (next.hostAway) {
        item.state = 'held';
        item.heldFrom = 'approved';
      } else {
        item.state = 'approved';
      }
      if (!next.order.includes(item.item)) next.order.push(item.item);
      return done([item.item]);
    case 'queue.reject':
      if (item.state !== 'queued') return refuse('conflict', QUEUE_DETAILS.state);
      item.state = 'rejected';
      unorder(item.item);
      return done([item.item]);
    case 'queue.drop':
      if (!(item.state === 'queued' || isApproved(item))) {
        return refuse('conflict', QUEUE_DETAILS.state);
      }
      item.state = 'dropped';
      delete item.heldFrom;
      unorder(item.item);
      return done([item.item]);
    case 'queue.claim': {
      if (isRunning(item)) return refuse('forbidden', QUEUE_DETAILS.claimed);
      if (item.state !== 'approved') return refuse('conflict', QUEUE_DETAILS.state);
      for (const other of next.items.values()) {
        if (other.agentId === op.agentId && isRunning(other)) {
          return refuse('forbidden', QUEUE_DETAILS.agentBusy);
        }
      }
      item.state = 'running';
      item.agentId = op.agentId;
      unorder(item.item);
      return done([item.item]);
    }
    case 'queue.done':
      if (!isRunning(item)) return refuse('conflict', QUEUE_DETAILS.state);
      item.state = op.outcome === 'ok' ? 'done' : op.outcome === 'error' ? 'failed' : 'canceled';
      delete item.heldFrom;
      return done([item.item]);
  }
}

/** `queue.state`'s body: live items, ordered ones first by position, then the rest by seq. */
export function view(model: QueueModel): QueueStateBody {
  const positions = new Map<string, number>();
  let n = 0;
  for (const id of model.order) {
    const item = model.items.get(id);
    if (item !== undefined && waiting(item)) positions.set(id, (n += 1));
  }
  const live = [...model.items.values()].filter((i) => LIVE_STATES.has(i.state));
  live.sort((a, b) => {
    const pa = positions.get(a.item);
    const pb = positions.get(b.item);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return a.createdSeq - b.createdSeq;
  });
  return {
    version: model.version,
    items: live.map((i) => ({
      item: i.item,
      submitter: i.submitter,
      state: i.state,
      position: positions.get(i.item) ?? null,
      size: i.size,
      kind: i.kind,
      ts: i.ts,
      ...(i.agentId === undefined ? {} : { agent_id: i.agentId }),
    })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The op of a queue frame `k` from `from` with clear payload `p`; null for anything else. */
export function opOf(k: string, from: string, p: unknown): QueueOp | null {
  if (!isRecord(p)) return null;
  const item = str(p['item']);
  switch (k) {
    case 'queue.submit':
      return {
        k,
        from,
        item,
        size: typeof p['size'] === 'number' ? p['size'] : 0,
        kind: p['kind'] === 'command' ? 'command' : 'message',
      };
    case 'queue.cancel':
      return { k, from, item };
    case 'queue.approve':
    case 'queue.reject':
    case 'queue.drop':
      return { k, item };
    case 'queue.reorder':
      return {
        k,
        order: Array.isArray(p['order']) ? p['order'].filter((x) => typeof x === 'string') : [],
      };
    case 'queue.claim':
      return { k, item, agentId: str(p['agent_id']) };
    case 'queue.done': {
      const outcome = p['outcome'];
      return {
        k,
        item,
        outcome: outcome === 'error' || outcome === 'canceled' ? outcome : 'ok',
      };
    }
    default:
      return null;
  }
}

/** A sequenced frame, as replay needs it. */
export interface ReplayFrame {
  t: string;
  k?: string;
  from: string;
  seq: number;
  ts: string;
  p?: unknown;
}

/** Takes a server `queue.state` checkpoint: its version, and which items are held. */
function checkpoint(model: QueueModel, p: unknown): QueueModel {
  if (!isRecord(p) || typeof p['version'] !== 'number' || !Array.isArray(p['items'])) return model;
  const next = cloneQueue(model);
  next.version = p['version'];
  let held = false;
  let present = false;
  for (const entry of p['items']) {
    if (!isRecord(entry)) continue;
    const item = next.items.get(str(entry['item']));
    if (item === undefined) continue;
    if (entry['state'] === 'held' && (item.state === 'approved' || item.state === 'running')) {
      item.heldFrom = item.state;
      item.state = 'held';
    } else if (entry['state'] !== 'held' && item.state === 'held' && item.heldFrom !== undefined) {
      item.state = item.heldFrom;
      delete item.heldFrom;
    }
    if (item.state === 'held') held = true;
    if (item.state === 'approved' || item.state === 'running') present = true;
  }
  if (held) next.hostAway = true;
  else if (present) next.hostAway = false;
  return next;
}

/** `model` after the sequenced `frames` (in `seq` order); refused ops are skipped. */
export function replay(model: QueueModel, frames: readonly ReplayFrame[]): QueueModel {
  let current = model;
  for (const f of frames) {
    if (f.t !== 'queue' || f.k === undefined) continue;
    if (f.k === 'queue.state') {
      current = checkpoint(current, f.p);
      continue;
    }
    const op = opOf(f.k, f.from, f.p);
    if (op === null) continue;
    const r = reduce(current, op, f.seq, f.ts);
    if (r.ok) current = r.model;
  }
  return current;
}
