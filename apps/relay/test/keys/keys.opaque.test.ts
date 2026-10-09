/**
 * Grants stay opaque (B049; tests "keys.opaque.test.ts", guardrail "`ct` and `sig` forwarded
 * byte-identical and never logged"): a grant whose `ct.c` and `sig` carry canary bytes is delivered
 * with them unchanged, and no log line holds them, whatever the outcome (routed or refused).
 */
import { describe, expect, it } from 'vitest';
import { CT, keysUnit } from './helpers.js';

const CANARY = 'Q0FOQVJZLWNhbmFyeS1ieXRlcw';

describe('opaque grants', () => {
  it('forwards ct and sig unchanged and never logs them', async () => {
    const u = keysUnit();
    const editor = u.member('editor');
    const target = u.member('viewer');
    const frame = {
      ...u.grant(target.dev, ['k1'], CT('k1', CANARY)),
      sig: `${CANARY}${'s'.repeat(86 - CANARY.length)}`,
    };
    await u.send(editor.conn, frame);
    const delivered = target.conn.frames().find((f) => f['k'] === 'key.grant');
    expect(delivered?.['ct']).toEqual(frame.ct);
    expect(delivered?.['sig']).toBe(frame.sig);
    // Refused ones too.
    await u.send(editor.conn, u.grant(target.dev, ['kx'], CT('k1', CANARY)));
    await u.send(editor.conn, { ...u.encrypted('k9'), ct: CT('k9', CANARY) });
    expect(u.log.raw()).not.toContain(CANARY);
  });
});
