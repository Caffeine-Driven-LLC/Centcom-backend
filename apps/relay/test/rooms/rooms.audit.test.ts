/**
 * Audit of denied frames (B043; tests "rooms.audit.test.ts", acceptance 9; CT-RBAC rule 6): each
 * denied frame writes exactly one `permission.denied` event with outcome `denied`, the session as
 * target and only the kind and the reason in `meta`, never `p`, `ct` or any frame content. Allowed
 * and muted frames write none. The event passes B036's real emitter (its catalogue and checks).
 * Rejected frames are logged with kind, session, member and result only.
 */
import { createAuditEmitter, type AuditDb } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { createRooms } from '../../src/rooms/authorise.js';
import { captureLogger } from '../helpers.js';
import { fixtureFrame, roomsHarness } from './helpers.js';

describe('denied frames are audited', () => {
  it('writes one denied event per refused frame, with no content', async () => {
    const h = roomsHarness();
    const { conn, user } = await h.admit('viewer');
    const prompt = fixtureFrame('message.user', h.sid);
    expect(await h.send(conn, prompt)).toBe(false);
    expect(await h.send(conn, fixtureFrame('control.roster', h.sid))).toBe(false);
    expect(await h.send(conn, fixtureFrame('reaction', h.sid))).toBe(true);
    expect(h.audited).toEqual([
      {
        workspaceId: h.wsp,
        actor: { type: 'user', id: user },
        action: 'permission.denied',
        target: { type: 'session', id: h.sid },
        outcome: 'denied',
        meta: { attempted: 'message.user', reason: 'role_viewer', session_id: h.sid },
      },
      {
        workspaceId: h.wsp,
        actor: { type: 'user', id: user },
        action: 'permission.denied',
        target: { type: 'session', id: h.sid },
        outcome: 'denied',
        meta: { attempted: 'control.roster', reason: 'server_only', session_id: h.sid },
      },
    ]);
    const text = JSON.stringify(h.audited);
    expect(text).not.toContain('"ct"');
    expect(text).not.toContain('xchacha20poly1305');
  });

  it('audits nothing for a muted member’s dropped frame', async () => {
    const h = roomsHarness();
    const { conn, mid } = await h.admit('editor');
    h.mute.mute(h.sid, mid);
    expect(await h.send(conn, fixtureFrame('message.user', h.sid))).toBe(false);
    expect(conn.sent).toEqual([]);
    expect(h.audited).toEqual([]);
  });

  it('produces events B036’s emitter accepts, and logs no payload', async () => {
    const h = roomsHarness();
    const inserts: { parameters: readonly unknown[] }[] = [];
    const db: AuditDb = {
      isTransaction: false,
      executeQuery: (query) => {
        inserts.push(query);
        return Promise.resolve({ rows: [] });
      },
    };
    const emitter = createAuditEmitter({ db });
    const log = captureLogger();
    const rooms = createRooms({
      registry: h.registry,
      membership: h.membership,
      mute: h.mute,
      audit: emitter,
      logger: log.logger,
    });
    const { conn } = await h.admit('editor');
    const frame = fixtureFrame('queue.approve', h.sid);
    await rooms.stage({ connection: conn, raw: JSON.stringify(frame), frame, state: {} }, () =>
      Promise.resolve(),
    );
    await emitter.flush(1_000);
    expect(inserts).toHaveLength(1);
    expect(JSON.stringify(inserts[0]?.parameters)).toContain('permission.denied');
    const line = log.lines().find((l) => l['msg'] === 'relay.frame_forbidden');
    expect(line).toMatchObject({ kind: 'queue.approve', result: 'forbidden', sid: h.sid });
    expect(log.raw()).not.toContain('"p":');
    expect(log.raw()).not.toContain(String(frame['id']));
  });
});
