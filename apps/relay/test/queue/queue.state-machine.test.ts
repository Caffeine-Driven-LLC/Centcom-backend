/**
 * The queue state machine (B052; tests "queue.state-machine.test.ts"): every op from every item
 * state, legal or not, against CT-WS-QUEUE's diagram and rules; order from approve and reorder
 * only; one agent, one running item; host loss; the version; the view.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  emptyQueue,
  reduce,
  view,
  type QueueModel,
  type QueueOp,
  type QueueState,
} from '../../src/queue/state-machine.js';

const SUBMITTER = newId('mem');
const OTHER = newId('mem');
const AGENT = newId('agt');
const TS = '2026-10-10T00:00:00.000Z';

/** A queue holding one item in `state` (held: from `heldFrom`). */
function withItem(
  state: QueueState,
  heldFrom?: 'approved' | 'running',
): { model: QueueModel; item: string } {
  const item = newId('que');
  const model = emptyQueue();
  model.items.set(item, {
    item,
    submitter: SUBMITTER,
    state,
    ...(heldFrom === undefined ? {} : { heldFrom }),
    size: 3,
    kind: 'message',
    ts: TS,
    ...(state === 'running' || heldFrom === 'running' ? { agentId: newId('agt') } : {}),
    createdSeq: 1,
    updatedSeq: 1,
  });
  if (state === 'approved' || heldFrom === 'approved') model.order.push(item);
  if (state === 'held') model.hostAway = true;
  model.version = 1;
  return { model, item };
}

type Start = [QueueState, ('approved' | 'running')?];
const STARTS: Start[] = [
  ['queued'],
  ['approved'],
  ['running'],
  ['held', 'approved'],
  ['held', 'running'],
  ['done'],
  ['failed'],
  ['canceled'],
  ['rejected'],
  ['dropped'],
];

const OPS: Record<string, (item: string) => QueueOp> = {
  cancel: (item) => ({ k: 'queue.cancel', from: SUBMITTER, item }),
  'cancel by another': (item) => ({ k: 'queue.cancel', from: OTHER, item }),
  approve: (item) => ({ k: 'queue.approve', item }),
  reject: (item) => ({ k: 'queue.reject', item }),
  drop: (item) => ({ k: 'queue.drop', item }),
  claim: (item) => ({ k: 'queue.claim', item, agentId: AGENT }),
  'done ok': (item) => ({ k: 'queue.done', item, outcome: 'ok' }),
  'done error': (item) => ({ k: 'queue.done', item, outcome: 'error' }),
  'done canceled': (item) => ({ k: 'queue.done', item, outcome: 'canceled' }),
};

/** The expected result: the new state, or the refusal. */
const EXPECTED: Record<string, Record<string, string>> = {
  queued: {
    cancel: 'canceled',
    'cancel by another': '!forbidden',
    approve: 'approved',
    reject: 'rejected',
    drop: 'dropped',
    claim: '!conflict',
    'done ok': '!conflict',
    'done error': '!conflict',
    'done canceled': '!conflict',
  },
  approved: {
    cancel: 'canceled',
    'cancel by another': '!forbidden',
    approve: '!conflict',
    reject: '!conflict',
    drop: 'dropped',
    claim: 'running',
    'done ok': '!conflict',
    'done error': '!conflict',
    'done canceled': '!conflict',
  },
  running: {
    cancel: '!conflict',
    'cancel by another': '!forbidden',
    approve: '!conflict',
    reject: '!conflict',
    drop: '!conflict',
    claim: '!forbidden',
    'done ok': 'done',
    'done error': 'failed',
    'done canceled': 'canceled',
  },
  'held:approved': {
    cancel: 'canceled',
    'cancel by another': '!forbidden',
    approve: '!conflict',
    reject: '!conflict',
    drop: 'dropped',
    claim: '!conflict',
    'done ok': '!conflict',
    'done error': '!conflict',
    'done canceled': '!conflict',
  },
  'held:running': {
    cancel: '!conflict',
    'cancel by another': '!forbidden',
    approve: '!conflict',
    reject: '!conflict',
    drop: '!conflict',
    claim: '!forbidden',
    'done ok': 'done',
    'done error': 'failed',
    'done canceled': 'canceled',
  },
};

describe('every op from every state', () => {
  for (const [state, heldFrom] of STARTS) {
    const name = heldFrom === undefined ? state : `${state}:${heldFrom}`;
    for (const [opName, make] of Object.entries(OPS)) {
      const terminal = EXPECTED[name] === undefined;
      const expected = terminal ? '!queue_item_gone' : (EXPECTED[name]?.[opName] ?? '?');
      it(`${name} + ${opName} → ${expected.replace('!', 'refused ')}`, () => {
        const { model, item } = withItem(state, heldFrom);
        const r = reduce(model, make(item), 2, TS);
        if (expected.startsWith('!')) {
          expect(r).toMatchObject({ ok: false, refusal: expected.slice(1) });
          return;
        }
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.model.items.get(item)?.state).toBe(expected);
        expect(r.model.version).toBe(2);
        expect(r.model.items.get(item)?.updatedSeq).toBe(2);
        // The input is never changed.
        expect(model.items.get(item)?.state).toBe(state);
        expect(model.version).toBe(1);
      });
    }
  }

  it('an unknown item: queue_item_gone for every op', () => {
    for (const make of Object.values(OPS)) {
      expect(reduce(emptyQueue(), make(newId('que')), 1, TS)).toMatchObject({
        ok: false,
        refusal: 'queue_item_gone',
      });
    }
  });
});

describe('rules', () => {
  const submit = (item = newId('que'), from = SUBMITTER): QueueOp => ({
    k: 'queue.submit',
    from,
    item,
    size: 3,
    kind: 'message',
  });

  /** Applies ops in order; the final model (throws on a refusal). */
  function run(ops: QueueOp[], start = emptyQueue()): QueueModel {
    let model = start;
    ops.forEach((op, i) => {
      const r = reduce(model, op, i + 1, TS);
      if (!r.ok) throw new Error(`${op.k} refused: ${r.refusal}`);
      model = r.model;
    });
    return model;
  }

  it('a submit makes a queued item without a position; a resubmit is a duplicate', () => {
    const item = newId('que');
    const model = run([submit(item)]);
    expect(view(model)).toEqual({
      version: 1,
      items: [
        {
          item,
          submitter: SUBMITTER,
          state: 'queued',
          position: null,
          size: 3,
          kind: 'message',
          ts: TS,
        },
      ],
    });
    expect(reduce(model, submit(item), 2, TS)).toMatchObject({ ok: false, refusal: 'duplicate' });
  });

  it('approve appends to the order; reorder puts the listed waiting items first', () => {
    const [a, b, c] = [newId('que'), newId('que'), newId('que')];
    let model = run([
      submit(a),
      submit(b),
      submit(c),
      { k: 'queue.approve', item: a },
      { k: 'queue.approve', item: b },
    ]);
    expect(view(model).items.map((i) => [i.item, i.position])).toEqual([
      [a, 1],
      [b, 2],
      [c, null],
    ]);
    const r = reduce(model, { k: 'queue.reorder', order: [c, b] }, 6, TS);
    expect(r).toMatchObject({ ok: true, gone: false });
    if (!r.ok) return;
    model = r.model;
    expect(view(model).items.map((i) => [i.item, i.position])).toEqual([
      [c, 1],
      [b, 2],
      [a, 3],
    ]);
  });

  it('reorder ignores unknown and finished ids and reports them; all unknown is refused', () => {
    const [a, b] = [newId('que'), newId('que')];
    const model = run([
      submit(a),
      submit(b),
      { k: 'queue.approve', item: a },
      { k: 'queue.drop', item: b },
    ]);
    const r = reduce(model, { k: 'queue.reorder', order: [newId('que'), b, a] }, 9, TS);
    expect(r).toMatchObject({ ok: true, gone: true });
    expect(reduce(model, { k: 'queue.reorder', order: [newId('que'), b] }, 9, TS)).toMatchObject({
      ok: false,
      refusal: 'queue_item_gone',
    });
  });

  it('one agent runs one item at a time; an item is claimed once', () => {
    const [a, b] = [newId('que'), newId('que')];
    const model = run([
      submit(a),
      submit(b),
      { k: 'queue.approve', item: a },
      { k: 'queue.approve', item: b },
      { k: 'queue.claim', item: a, agentId: AGENT },
    ]);
    expect(reduce(model, { k: 'queue.claim', item: b, agentId: AGENT }, 9, TS)).toMatchObject({
      ok: false,
      refusal: 'forbidden',
    });
    expect(
      reduce(model, { k: 'queue.claim', item: a, agentId: newId('agt') }, 9, TS),
    ).toMatchObject({
      ok: false,
      refusal: 'forbidden',
    });
    const other = reduce(model, { k: 'queue.claim', item: b, agentId: newId('agt') }, 9, TS);
    expect(other.ok).toBe(true);
    // Running items leave the order.
    if (other.ok) expect(view(other.model).items.every((i) => i.position === null)).toBe(true);
  });

  it('host loss holds approved and running items, approvals while away are held, return restores', () => {
    const [a, b, c] = [newId('que'), newId('que'), newId('que')];
    let model = run([
      submit(a),
      submit(b),
      submit(c),
      { k: 'queue.approve', item: a },
      { k: 'queue.approve', item: b },
      { k: 'queue.claim', item: b, agentId: AGENT },
      { k: 'host', away: true },
      { k: 'queue.approve', item: c },
    ]);
    expect(view(model).items.map((i) => [i.item, i.state])).toEqual([
      [a, 'held'],
      [c, 'held'],
      [b, 'held'],
    ]);
    expect(reduce(model, { k: 'host', away: true }, 9, TS)).toMatchObject({ ok: false });
    model = run([{ k: 'host', away: false }], model);
    expect(view(model).items.map((i) => [i.item, i.state])).toEqual([
      [a, 'approved'],
      [c, 'approved'],
      [b, 'running'],
    ]);
  });

  it('the version rises by one per accepted op and never on a refusal', () => {
    const a = newId('que');
    const model = run([submit(a), { k: 'queue.approve', item: a }]);
    expect(model.version).toBe(2);
    const refused = reduce(model, { k: 'queue.reject', item: a }, 3, TS);
    expect(refused.ok).toBe(false);
    expect(model.version).toBe(2);
  });
});
