/**
 * Opaque routing (B044; tests "fanout.opaque.test.ts", acceptance 2 and 7): the delivered `ct`,
 * `sig`, `p` and `id` are byte-identical to the sender's (compared as raw JSON substrings of the
 * frame the client sent), over random-byte `ct` values; `from`, `ts` and `seq` are the server's;
 * every recipient gets the same text as the echo and the hot buffer; unknown kinds are delivered
 * unchanged.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fanoutUnit, newId, type TextConnection } from './helpers.js';

const b64 = (n: number) => randomBytes(n).toString('base64url');

describe('opaque fan-out', () => {
  it('keeps ct, sig, p and id byte-identical over random payloads (acceptance 2)', async () => {
    const u = fanoutUnit();
    const [a, b] = [u.join(), u.join()] as [TextConnection, TextConnection];
    for (let i = 0; i < 50; i++) {
      const id = newId('msg');
      const ct = `{"alg":"xchacha20poly1305","kid":"k${i}","n":"${b64(24)}","c":"${b64(1 + i * 37)}"}`;
      const sig = b64(64);
      const p = `{"agent_id":"${newId('agt')}","risk":"low","note":"\\u00e9\\n${b64(5)}"}`;
      const raw = `{"v":1,"t":"event","id":"${id}","sid":"${u.sid}","k":"approval.request","p":${p},"ct":${ct},"sig":"${sig}"}`;
      const decoded = JSON.parse(raw) as Record<string, unknown>;
      await u.send(a, decoded);
      for (const conn of [a, b]) {
        const text = conn.texts.at(-1) ?? '';
        expect(text).toContain(`"ct":${ct}`);
        expect(text).toContain(`"p":${JSON.stringify(JSON.parse(p))}`);
        expect(text).toContain(`"sig":"${sig}"`);
        expect(text).toContain(`"id":"${id}"`);
        const out = JSON.parse(text) as Record<string, unknown>;
        expect(out['from']).toBe(a.entry.memberId);
        expect(out['seq']).toBe(i + 1);
        expect(typeof out['ts']).toBe('string');
      }
      // The same bytes as the hot buffer keeps.
      const [buffered] = await u.store.range(u.sid, i, 1);
      expect(a.texts.at(-1)).toBe(JSON.stringify(buffered));
      expect(b.texts.at(-1)).toBe(a.texts.at(-1));
    }
  });

  it('never trusts a client from, ts or seq', async () => {
    const u = fanoutUnit();
    const a = u.join();
    await u.send(a, {
      v: 1,
      t: 'event',
      id: newId('msg'),
      sid: u.sid,
      k: 'reaction',
      p: { target: newId('msg'), code: 'x', op: 'add' },
      from: 'mem_FAKE',
      ts: '1999-01-01T00:00:00.000Z',
      seq: 999,
    });
    const out = a.frames()[0] ?? {};
    expect(out['from']).toBe(a.entry.memberId);
    expect(out['seq']).toBe(1);
    expect(out['ts']).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('delivers unknown kinds unchanged, without closing (acceptance 7)', async () => {
    const u = fanoutUnit();
    const [a, b] = [u.join(), u.join()] as [TextConnection, TextConnection];
    await u.send(a, {
      v: 1,
      t: 'event',
      id: newId('msg'),
      sid: u.sid,
      k: 'hologram.wave',
      ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'AAAA', c: 'BBBB' },
    });
    expect(b.frames()[0]).toMatchObject({ k: 'hologram.wave', seq: 1, ct: { c: 'BBBB' } });
    expect(a.closedWith).toBeNull();
    expect(b.closedWith).toBeNull();
  });
});
