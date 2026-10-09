/**
 * The clear-payload allowlist (B050; tests "privacy.sanitize.test.ts", acceptance 1, 2, 7 and 8,
 * guardrail "a new kind fails the suite until the table is updated"): for every kind of the
 * CT-WS-SESSION-EVENTS catalogue (its fixtures), the gate keeps only the fields of the cleartext
 * column, so an extra `p.note: "secret text"` is gone before sequencing; an encrypted kind keeps no
 * `p`; a fast-check property adds random extra fields to every kind. An unknown kind keeps `p` as it
 * came. A clear `p` over 8 KiB is `invalid_frame` (server-built kinds aside). The gate costs under
 * 0.2 ms per frame at p95.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { EVENT_CATALOGUE, EVENT_KINDS, newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_CLEAR_BYTES, sanitizeClearPayload } from '../../src/privacy/sanitize.js';
import { privacyStage } from '../../src/privacy/stage.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { textConnection } from '../fanout/helpers.js';
import { recordingMetrics } from '../helpers.js';

const FIXTURES = new URL('../../../../contracts/fixtures/events/', import.meta.url);
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map(
    (f) =>
      JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8')) as {
        kind: string;
        frame: Record<string, unknown>;
      },
  );

/** The table the gate must follow: kind → its clear fields (generated from the catalogue). */
const TABLE: Record<string, string[]> = Object.fromEntries(
  Object.entries(EVENT_CATALOGUE).map(([kind, e]) => [
    kind,
    e.mode === 'encrypted' ? [] : [...e.clearFields],
  ]),
);

function gate() {
  const recorded = recordingMetrics();
  const stage = privacyStage({ metrics: recorded.metrics });
  const conn = textConnection(new ConnectionRegistry({ max: 10 }), newId('ses'));
  return {
    recorded,
    conn,
    async pass(frame: Record<string, unknown>): Promise<boolean> {
      let passed = false;
      await stage({ connection: conn, raw: '', frame, state: {} }, () => {
        passed = true;
        return Promise.resolve();
      });
      return passed;
    },
  };
}

describe('the catalogue table (acceptance 1)', () => {
  it('covers every kind of the catalogue, and every kind has a fixture', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...EVENT_KINDS].sort());
    expect(fixtures.map((f) => f.kind).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it('keeps only the cleartext column of every kind; p.note is gone before sequencing', async () => {
    for (const { kind, frame } of fixtures) {
      const g = gate();
      const p = {
        ...((frame['p'] as Record<string, unknown> | undefined) ?? {}),
        note: 'secret text',
      };
      const sent = { ...frame, p };
      expect(await g.pass(sent), kind).toBe(true);
      const after = (sent as { p?: Record<string, unknown> }).p ?? {};
      expect(
        Object.keys(after).every((k) => TABLE[kind]?.includes(k)),
        kind,
      ).toBe(true);
      expect(after).not.toHaveProperty('note');
      for (const field of TABLE[kind] ?? []) {
        if ((frame['p'] as Record<string, unknown> | undefined)?.[field] !== undefined) {
          expect(after[field], `${kind}.${field}`).toEqual(
            (frame['p'] as Record<string, unknown>)[field],
          );
        }
      }
      expect(
        g.recorded.count('relay_privacy_violations_total', { where: 'frame' }),
      ).toBeGreaterThan(0);
    }
  });

  it('a random set of extra fields never survives, for any kind (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EVENT_KINDS),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.jsonValue(), { maxKeys: 8 }),
        (kind, extra) => {
          const clean = sanitizeClearPayload(kind, extra);
          expect(clean.ok).toBe(true);
          if (!clean.ok) return;
          for (const key of Object.keys(clean.p)) expect(TABLE[kind]).toContain(key);
          expect(clean.dropped).toBe(
            Object.keys(extra).filter((k) => !TABLE[kind]?.includes(k)).length,
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('encrypted and unknown kinds (acceptance 2)', () => {
  it('drops any p on an encrypted kind that reaches the gate; logs only the kind', async () => {
    const g = gate();
    const frame: Record<string, unknown> = {
      v: 1,
      t: 'event',
      id: newId('msg'),
      k: 'message.user',
      p: { text: 'secret' },
      ct: {},
    };
    expect(await g.pass(frame)).toBe(true);
    expect(frame).not.toHaveProperty('p');
  });

  it('drops a p that is not an object, on an encrypted and on a clear kind', async () => {
    for (const p of ['secret text', ['secret'], 7]) {
      const g = gate();
      const encrypted: Record<string, unknown> = {
        v: 1,
        t: 'event',
        id: newId('msg'),
        k: 'message.user',
        p,
        ct: {},
      };
      expect(await g.pass(encrypted)).toBe(true);
      expect(encrypted).not.toHaveProperty('p');
      const clear: Record<string, unknown> = {
        v: 1,
        t: 'event',
        id: newId('msg'),
        k: 'reaction',
        p,
      };
      expect(await g.pass(clear)).toBe(true);
      expect(clear['p']).toEqual({});
      expect(g.recorded.count('relay_privacy_violations_total', { where: 'frame' })).toBe(2);
    }
  });

  it('carries an unknown kind’s p as it came', async () => {
    const g = gate();
    const p = { anything: 'goes', n: 1 };
    const frame: Record<string, unknown> = {
      v: 1,
      t: 'event',
      id: newId('msg'),
      k: 'future.kind',
      p,
    };
    expect(await g.pass(frame)).toBe(true);
    expect(frame['p']).toBe(p);
    expect(sanitizeClearPayload('future.kind', p)).toEqual({ ok: false });
  });

  it('leaves a frame with nothing to drop untouched (the same object)', async () => {
    const g = gate();
    const p = { target: newId('msg'), code: 'thumbs', op: 'add' };
    const frame: Record<string, unknown> = { v: 1, t: 'event', id: newId('msg'), k: 'reaction', p };
    await g.pass(frame);
    expect(frame['p']).toBe(p);
    expect(g.recorded.count('relay_privacy_violations_total', { where: 'frame' })).toBe(0);
  });
});

describe('the size cap (acceptance 7)', () => {
  it('a clear p over 8 KiB is invalid_frame; at 8 KiB it passes; server-built kinds are exempt', async () => {
    const big = (bytes: number) => ({ target: 'x'.repeat(bytes - '{"target":""}'.length) });
    const g = gate();
    expect(await g.pass({ v: 1, t: 'event', k: 'reaction', p: big(MAX_CLEAR_BYTES) })).toBe(true);
    expect(
      await g.pass({
        v: 1,
        t: 'event',
        id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
        k: 'reaction',
        p: big(MAX_CLEAR_BYTES + 1),
      }),
    ).toBe(false);
    expect(g.conn.frames().at(-1)).toMatchObject({
      t: 'sys.error',
      ref: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      p: { code: 'invalid_frame', errors: [{ pointer: '/p' }] },
    });
    // Unknown kinds too.
    expect(await g.pass({ v: 1, t: 'event', k: 'future.kind', p: big(MAX_CLEAR_BYTES + 1) })).toBe(
      false,
    );
    expect(
      await g.pass({
        v: 1,
        t: 'queue',
        k: 'queue.state',
        p: { version: 1, items: ['x'.repeat(20_000)] },
      }),
    ).toBe(true);
  });
});

describe('cost (acceptance 8)', () => {
  it('under 0.2 ms per frame at p95', async () => {
    const g = gate();
    const times: number[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      const frame = {
        v: 1,
        t: 'event',
        id: newId('msg'),
        k: 'agent.spawn',
        p: { agent_id: 'a', owner: 'o', mode: 'm', runs_on: 'r', provider: 'p', note: 'secret' },
        ct: {},
      };
      const t0 = performance.now();
      await g.pass(frame);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(0.2);
  });
});
