/**
 * Frame authorisation (B043; tests "rooms.authorize.matrix.test.ts"): kind × role × muted,
 * table-driven, and the coverage of `KIND_MIN_ROLE` against every kind in
 * `contracts/schemas/events.schema.json`.
 *
 * - A viewer may send `reaction`, `comment.add` and `presence.update`, nothing else; `message.user`
 *   and `queue.submit` are forbidden (acceptance 1).
 * - An editor may not send `queue.approve` or any `control.*` (acceptance 1); the host may send
 *   every host-allowed kind.
 * - Server-only kinds are forbidden for every role, the host included (acceptance 2).
 * - A muted member's `event` and `queue` frames are dropped (`muted`), `presence` and `control`
 *   are not (acceptance 3).
 * - Unknown kinds pass for host and editor only; a frame without a kind is forbidden.
 */
import { readFileSync } from 'node:fs';
import { EVENT_CATALOGUE } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  authorizeFrame,
  KIND_MIN_ROLE,
  memoryMuteState,
  noMutes,
  SERVER_ONLY_KINDS,
  type SessionRole,
} from '../../src/rooms/kind-policy.js';
import { KINDS } from './helpers.js';

const ROLES: readonly SessionRole[] = ['host', 'editor', 'viewer'];
const SID = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const MID = 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

/** The `t` of each kind. */
const typeOf = (kind: string): string =>
  (EVENT_CATALOGUE as Record<string, { t: string }>)[kind]?.t ?? 'event';

/** Every kind `k` in events.schema.json, read from the file itself. */
function schemaKinds(): string[] {
  const url = new URL('../../../../contracts/schemas/events.schema.json', import.meta.url);
  const schema = JSON.parse(readFileSync(url, 'utf8')) as {
    allOf: { if: { properties: { k: { const: string } } } }[];
  };
  return [...new Set(schema.allOf.map((rule) => rule.if.properties.k.const))].sort();
}

const SERVER_ONLY = [
  'control.member_joined',
  'control.member_left',
  'control.roster',
  'control.host_changed',
  'control.session_state',
  'control.rotate_key',
  'queue.state',
];

/** Expected roles per kind (an independent copy of the catalogue, so the table is checked). */
const EXPECTED: Record<string, readonly SessionRole[]> = {
  reaction: ROLES,
  'comment.add': ROLES,
  'presence.update': ROLES,
  'queue.approve': ['host'],
  'queue.reject': ['host'],
  'queue.reorder': ['host'],
  'queue.drop': ['host'],
  'queue.claim': ['host'],
  'queue.done': ['host'],
  'control.kick': ['host'],
  'control.mute': ['host'],
  'control.unmute': ['host'],
  'control.role': ['host'],
  'control.transfer_host': ['host'],
  'control.end': ['host'],
  'control.policy': ['host'],
  'control.rotate_request': ['host'],
  ...Object.fromEntries(SERVER_ONLY.map((k) => [k, []])),
};
const expectedRoles = (kind: string): readonly SessionRole[] =>
  EXPECTED[kind] ?? ['host', 'editor'];

describe('KIND_MIN_ROLE', () => {
  it('covers every kind in events.schema.json, and nothing else', () => {
    expect(Object.keys(KIND_MIN_ROLE).sort()).toEqual(schemaKinds());
    expect(Object.keys(KIND_MIN_ROLE).sort()).toEqual([...KINDS].sort());
  });

  it('lists exactly the server-only kinds as server-only', () => {
    expect([...SERVER_ONLY_KINDS].sort()).toEqual([...SERVER_ONLY].sort());
  });
});

describe('authorizeFrame: kind × role × muted', () => {
  const cases = KINDS.flatMap((kind) =>
    ROLES.flatMap((role) => [false, true].map((muted) => ({ kind, role, muted }))),
  );

  it.each(cases)('$role sending $kind (muted: $muted)', ({ kind, role, muted }) => {
    const mute = memoryMuteState();
    if (muted) mute.mute(SID, MID);
    const t = typeOf(kind);
    const decision = authorizeFrame({ id: MID, sid: SID, role }, { t, k: kind }, mute);
    if (!expectedRoles(kind).includes(role)) {
      expect(decision).toEqual({ ok: false, error: 'forbidden' });
    } else if (muted && (t === 'event' || t === 'queue')) {
      expect(decision).toEqual({ ok: false, error: 'muted' });
    } else {
      expect(decision).toEqual({ ok: true });
    }
  });

  it('acceptance 1: viewers, editors and the host', () => {
    const can = (role: SessionRole, kind: string) =>
      authorizeFrame({ id: MID, sid: SID, role }, { t: typeOf(kind), k: kind }, noMutes).ok;
    expect(can('viewer', 'message.user')).toBe(false);
    expect(can('viewer', 'queue.submit')).toBe(false);
    expect(can('viewer', 'reaction')).toBe(true);
    expect(can('viewer', 'comment.add')).toBe(true);
    expect(can('editor', 'queue.approve')).toBe(false);
    for (const kind of KINDS.filter((k) => k.startsWith('control.'))) {
      expect(can('editor', kind), kind).toBe(false);
    }
    for (const kind of KINDS.filter((k) => expectedRoles(k).includes('host'))) {
      expect(can('host', kind), kind).toBe(true);
    }
  });

  it('acceptance 2: server-only kinds are refused for every role', () => {
    for (const kind of SERVER_ONLY) {
      for (const role of ROLES) {
        expect(
          authorizeFrame({ id: MID, sid: SID, role }, { t: typeOf(kind), k: kind }, noMutes),
        ).toEqual({ ok: false, error: 'forbidden' });
      }
    }
  });

  it('acceptance 3: a mute drops event and queue frames, not presence or control', () => {
    const mute = memoryMuteState();
    mute.mute(SID, MID);
    const host = { id: MID, sid: SID, role: 'host' as const };
    expect(authorizeFrame(host, { t: 'event', k: 'message.user' }, mute)).toEqual({
      ok: false,
      error: 'muted',
    });
    expect(authorizeFrame(host, { t: 'queue', k: 'queue.submit' }, mute).ok).toBe(false);
    expect(authorizeFrame(host, { t: 'presence', k: 'presence.update' }, mute)).toEqual({
      ok: true,
    });
    expect(authorizeFrame(host, { t: 'control', k: 'control.end' }, mute)).toEqual({ ok: true });
    mute.unmute(SID, MID);
    expect(authorizeFrame(host, { t: 'event', k: 'message.user' }, mute)).toEqual({ ok: true });
  });

  it('forwards unknown kinds for host and editor only, and refuses a frame without a kind', () => {
    for (const role of ROLES) {
      const decision = authorizeFrame(
        { id: MID, sid: SID, role },
        { t: 'event', k: 'hologram.wave' },
        noMutes,
      );
      expect(decision.ok, role).toBe(role !== 'viewer');
    }
    expect(authorizeFrame({ id: MID, sid: SID, role: 'host' }, { t: 'event' }, noMutes)).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});
