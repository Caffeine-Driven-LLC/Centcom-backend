/**
 * The control fixtures (B051; tests "control.contract.test.ts"): every client control fixture in
 * `contracts/fixtures/events/control.*.json` decodes (B039) and, with its ids pointed at real
 * members, goes through the handler; every frame the relay emits for it (`member_left`,
 * `rotate_key`, `host_changed`, `session_state`) validates against the generated envelope and
 * payload schemas, as do the server-kind fixtures themselves.
 */
import { validateEnvelope, validateEvent, type EventKind } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../../src/codec/codec.js';
import { CLIENT_CONTROL_KINDS } from '../../src/control/authority.js';
import { controlUnit, fixture } from './helpers.js';

const SERVER_KINDS = [
  'control.member_left',
  'control.rotate_key',
  'control.host_changed',
  'control.session_state',
] as const;

describe('control fixtures', () => {
  for (const kind of CLIENT_CONTROL_KINDS) {
    it(`${kind}: decodes, is accepted, and what the relay emits validates`, async () => {
      const u = controlUnit();
      const host = u.member('host');
      const target = u.member('editor');
      const frame = fixture(kind);
      const decoded = decodeFrame(JSON.stringify(frame), false, String(frame['sid']));
      expect(decoded.ok).toBe(true);
      const p = { ...(frame['p'] as Record<string, unknown>) };
      if ('member' in p) p['member'] = target.mid;
      if ('to' in p) p['to'] = target.mid;
      if (kind === 'control.mute') p['until'] = new Date(u.clock.now + 60_000).toISOString();
      const stored = await u.send(host.conn, u.ctl(kind, p));
      expect(u.errorsOf(host.conn)).toEqual([]);
      expect(stored?.seq).toBe(1);
      for (const f of await u.sequenced()) {
        expect(validateEnvelope(f)).toMatchObject({ ok: true });
        expect(validateEvent(f.k as EventKind, (f as { p?: unknown }).p)).toMatchObject({
          ok: true,
        });
      }
    });
  }

  for (const kind of SERVER_KINDS) {
    it(`${kind}: the fixture validates (the shape the relay emits)`, () => {
      const frame = fixture(kind);
      expect(validateEnvelope(frame)).toMatchObject({ ok: true });
      expect(validateEvent(kind, frame['p'])).toMatchObject({ ok: true });
    });
  }

  it('emits each server kind in the shape of its fixture', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const a = u.member('editor');
    const b = u.member('editor');
    await u.send(host.conn, u.ctl('control.kick', { member: a.mid, code: 'other' }));
    await u.send(host.conn, u.ctl('control.transfer_host', { to: b.mid }));
    await u.send(b.conn, u.ctl('control.end', { code: 'done' }));
    const emitted = (await u.sequenced()).filter((f) => f.from === 'srv');
    expect(emitted.map((f) => f.k)).toEqual([...SERVER_KINDS]);
    for (const f of emitted) {
      const shape = Object.keys(fixture(f.k)['p'] as object).sort();
      expect(Object.keys((f as { p: object }).p).sort()).toEqual(shape);
    }
  });
});
