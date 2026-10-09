/**
 * `key.grant` routing (B049; tests "keys.grant-validation.test.ts", acceptance 1 and 2, guardrail
 * "only `to_device` and `kids` are read"): a grant from an editor to a device of a member of the
 * session, `kids: ["k1"]`, is sequenced and delivered to every member with `p` and `ct`
 * byte-identical; from a viewer it is `forbidden`. A device not in the session, `kids` empty or
 * over 200, or a kid like `k0`, `kx` or past the next epoch is `invalid_frame` and not sequenced.
 * The contract fixture (`key.grant.json`) routes once its kid is a real one. A device lookup that
 * fails refuses the grant 503 (fail closed).
 */
import { readFileSync } from 'node:fs';
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { validateKeyGrant } from '../../src/keys/validate.js';
import { CT, keysUnit } from './helpers.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/fixtures/events/key.grant.json', import.meta.url),
    'utf8',
  ),
) as { frame: Record<string, unknown> };

describe('a grant routes (acceptance 1)', () => {
  it('editor → a member device, kids [k1]: sequenced, delivered byte-identical to everyone', async () => {
    const u = keysUnit();
    const editor = u.member('editor');
    const target = u.member('viewer');
    const other = u.member('viewer');
    const frame = u.grant(target.dev, ['k1'], CT('k1', 'c2VhbGVkLWJveGVz'));
    const stored = await u.send(editor.conn, frame);
    expect(stored?.seq).toBe(1);
    for (const conn of [editor.conn, target.conn, other.conn]) {
      const [text] = conn.texts.filter((t) => t.includes('"key.grant"'));
      expect(text).toContain(JSON.stringify(frame.p));
      expect(text).toContain(JSON.stringify(frame.ct));
      expect(text).toContain(`"sig":"${'s'.repeat(86)}"`);
    }
    expect(u.recorded.count('relay_key_grants_total', { result: 'routed' })).toBe(1);
  });

  it('a viewer’s grant is forbidden and not sequenced', async () => {
    const u = keysUnit();
    const viewer = u.member('viewer');
    const target = u.member('editor');
    expect(await u.send(viewer.conn, u.grant(target.dev, ['k1']))).toBeUndefined();
    expect(u.errorsOf(viewer.conn)[0]).toMatchObject({ code: 'forbidden' });
    expect(await u.store.head(u.sid)).toBe(0);
  });

  it('routes the contract fixture with a real kid', async () => {
    const u = keysUnit();
    const host = u.member('host');
    const target = u.member('editor');
    const frame: Record<string, unknown> = {
      ...fixture.frame,
      sid: u.sid,
      p: { ...(fixture.frame['p'] as object), to_device: target.dev, kids: ['k1'] },
    };
    delete frame['from'];
    delete frame['ts'];
    delete frame['seq'];
    expect((await u.send(host.conn, frame))?.seq).toBe(1);
  });
});

describe('a grant is refused (acceptance 2)', () => {
  it('a device not in the session, empty kids, k0, kx, over 200 kids, past the next epoch', async () => {
    const u = keysUnit();
    const editor = u.member('editor');
    const target = u.member('viewer');
    const cases: [unknown, unknown[], string][] = [
      [newId('dev'), ['k1'], '/p/to_device'],
      ['dev_short', ['k1'], '/p/to_device'],
      [target.dev, [], '/p/kids'],
      [target.dev, ['k0'], '/p/kids/0'],
      [target.dev, ['k1', 'kx'], '/p/kids/1'],
      [target.dev, Array.from({ length: 201 }, () => 'k1'), '/p/kids'],
      [target.dev, ['k3'], '/p/kids/0'],
    ];
    for (const [dev, kids, pointer] of cases) {
      expect(await u.send(editor.conn, u.grant(dev as string, kids)), pointer).toBeUndefined();
      expect(u.errorsOf(editor.conn).at(-1), pointer).toMatchObject({
        code: 'invalid_frame',
        errors: [{ pointer }],
      });
    }
    expect(await u.store.head(u.sid)).toBe(0);
    // The next epoch's key may be granted ahead of its rotation.
    expect((await u.send(editor.conn, u.grant(target.dev, ['k1', 'k2'])))?.seq).toBe(1);
  });

  it('validateKeyGrant reads only to_device and kids', () => {
    const dev = newId('dev');
    expect(
      validateKeyGrant(
        { p: { to_device: dev, kids: ['k1'], other: 1 } },
        { role: 'host', epoch: 1 },
      ),
    ).toEqual({
      ok: true,
      toDevice: dev,
    });
    expect(validateKeyGrant({ p: null }, { role: 'editor', epoch: 1 })).toMatchObject({
      ok: false,
      pointer: '/p',
    });
    expect(validateKeyGrant({ p: {} }, { role: 'viewer', epoch: 1 })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('a device lookup that fails is a 503, not a routed grant', async () => {
    const u = keysUnit();
    const editor = u.member('editor');
    const target = u.member('viewer');
    u.devices.failing = true;
    expect(await u.send(editor.conn, u.grant(target.dev, ['k1']))).toBeUndefined();
    expect(u.errorsOf(editor.conn)[0]).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: 1,
    });
    expect(editor.conn.closedWith).toBeNull();
  });
});
