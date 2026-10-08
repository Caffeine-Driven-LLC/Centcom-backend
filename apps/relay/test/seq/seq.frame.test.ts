/**
 * Stamping and the stored JSON (B041): the server's fields in envelope order, the client's `ack`
 * consumed, `p`, `ct` and `sig` carried as they came, and the splice the stores use
 * (`prefix + seq + suffix`) equal to the frame's own JSON for any frame and any seq (property).
 */
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseStoredFrame,
  seqParts,
  stampFrame,
  withSeq,
  type SequencableFrame,
} from '../../src/seq/frame.js';

// JSON has no -0 (stringify writes 0), so frames, which always travel as JSON, never hold it.
const json = fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.parse(JSON.stringify(v)) as fc.JsonValue);

const sequencable: fc.Arbitrary<SequencableFrame> = fc.record(
  {
    t: fc.constantFrom('event' as const, 'queue' as const, 'control' as const),
    id: fc.constant(newId('msg')),
    k: fc.string({ minLength: 1, maxLength: 30 }),
    ref: fc.constant(newId('msg')),
    p: fc.dictionary(fc.string({ maxLength: 8 }), json, { maxKeys: 5 }),
    ct: fc.record({
      alg: fc.constant('xchacha20poly1305' as const),
      kid: fc.string({ maxLength: 8 }),
      n: fc.base64String({ maxLength: 40 }),
      c: fc.string({ maxLength: 200, unit: 'binary' }),
    }),
    sig: fc.string({ maxLength: 90 }),
  },
  { requiredKeys: ['t', 'id', 'k'] },
);

describe('stored frames', () => {
  it('splice to exactly the frame’s JSON, for any frame and seq (property)', () => {
    fc.assert(
      fc.property(
        sequencable,
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (frame, seq) => {
          const stamped = stampFrame(frame, newId('mem'), '2026-10-08T12:00:00.000Z', newId('ses'));
          const { prefix, suffix } = seqParts(stamped);
          const spliced = `${prefix}${seq}${suffix}`;
          expect(spliced).toBe(JSON.stringify(withSeq(stamped, seq)));
          expect(parseStoredFrame(spliced)).toEqual(withSeq(stamped, seq));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('stamps the server’s from, ts and sid in envelope order and drops the client’s ack', () => {
    const p = { target: newId('msg'), code: 'thumbs', op: 'add' };
    const ct = { alg: 'xchacha20poly1305' as const, kid: 'k1', n: 'bg', c: 'Yw' };
    const input = { t: 'event' as const, id: newId('msg'), k: 'reaction', p, ct, sig: 's', ack: 7 };
    const stamped = stampFrame(input, 'mem_server', '2026-10-08T12:00:00.000Z', 'ses_live');
    expect(Object.keys(stamped)).toEqual([
      'v',
      't',
      'id',
      'sid',
      'from',
      'ts',
      'k',
      'p',
      'ct',
      'sig',
    ]);
    expect(stamped).toMatchObject({ v: 1, sid: 'ses_live', from: 'mem_server' });
    expect(stamped.p).toBe(p);
    expect(stamped.ct).toBe(ct);
    expect(Object.keys(withSeq(stamped, 3))).toEqual([
      'v',
      't',
      'id',
      'sid',
      'from',
      'ts',
      'seq',
      'k',
      'p',
      'ct',
      'sig',
    ]);
  });

  it('splices a frame with only a kind after its seq', () => {
    const stamped = stampFrame({ t: 'control', id: 'msg_x', k: 'control.end' }, 'm', 't', 's');
    const { prefix, suffix } = seqParts(stamped);
    expect(`${prefix}12${suffix}`).toBe(
      '{"v":1,"t":"control","id":"msg_x","sid":"s","from":"m","ts":"t","seq":12,"k":"control.end"}',
    );
  });
});
