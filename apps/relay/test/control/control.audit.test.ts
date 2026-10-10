/**
 * The control audit trail (B051; tests "control.audit.test.ts", acceptance 9 and CT-WS-CONTROL
 * "Audit"): 50 accepted and 50 rejected control frames make exactly 100 audit events, one each,
 * with actor, target, kind and outcome, metadata limited to the action's allowlist (ids, enums,
 * field names), and no payload text. B036's real emitter accepts every one of them.
 */
import { newId } from '@centcom/contracts';
import { AUDIT_ACTIONS, createAuditEmitter, type AuditDb } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { controlUnit } from './helpers.js';

describe('control audit events', () => {
  it('one per frame for 50 accepted and 50 rejected, with actor, target, kind and outcome', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const editor = u.member('editor');
    const viewer = u.member('viewer');
    const targets = Array.from({ length: 10 }, () => u.member('editor'));
    const accepted: Record<string, unknown>[] = [];
    const rejected: { conn: (typeof host)['conn']; frame: Record<string, unknown> }[] = [];
    for (let i = 0; i < 10; i += 1) {
      const t = targets[i];
      if (t === undefined) continue;
      accepted.push(
        u.ctl('control.mute', { member: t.mid }),
        u.ctl('control.unmute', { member: t.mid }),
        u.ctl('control.role', { member: t.mid, role: 'viewer' }),
        u.ctl('control.role', { member: t.mid, role: 'editor' }),
        u.ctl('control.policy', { auto_approve: 'ask', share_history: false, queue_limit: i }),
      );
      // Denied by B043 (not the host) and refused by the handler (bad targets).
      rejected.push(
        { conn: editor.conn, frame: u.ctl('control.kick', { member: t.mid, code: 'abuse' }) },
        { conn: viewer.conn, frame: u.ctl('control.end', { code: 'done' }) },
        { conn: host.conn, frame: u.ctl('control.kick', { member: newId('mem'), code: 'other' }) },
        { conn: host.conn, frame: u.ctl('control.mute', { member: host.mid }) },
        { conn: host.conn, frame: u.ctl('control.transfer_host', { to: viewer.mid }) },
      );
    }
    for (const frame of accepted) await u.send(host.conn, frame);
    for (const r of rejected) await u.send(r.conn, r.frame);

    expect(accepted).toHaveLength(50);
    expect(rejected).toHaveLength(50);
    expect(u.audited).toHaveLength(100);
    expect(u.audited.filter((e) => e.outcome === 'success')).toHaveLength(50);
    expect(u.audited.filter((e) => e.outcome === 'denied')).toHaveLength(50);
    for (const e of u.audited) {
      expect(e.action).toMatch(/^control\./);
      expect(e.actor.type).toBe('user');
      expect(e.actor.id).toMatch(/^usr_/);
      expect(e.target?.type).toMatch(/^(session|session_member)$/);
      const allowed: readonly string[] = AUDIT_ACTIONS[e.action as keyof typeof AUDIT_ACTIONS].meta;
      expect(Object.keys(e.meta ?? {}).every((k) => allowed.includes(k))).toBe(true);
      expect(e.meta?.['session_id']).toBe(u.sid);
    }

    // B036's emitter takes every one.
    const inserts: { parameters: readonly unknown[] }[] = [];
    const db: AuditDb = {
      isTransaction: false,
      executeQuery: (query) => {
        inserts.push(query);
        return Promise.resolve({ rows: [] });
      },
    };
    const emitter = createAuditEmitter({ db });
    for (const e of u.audited) emitter.emitDetached(e);
    await emitter.flush(5_000);
    // Batched: count the rows' actions across the inserts.
    const actions = inserts
      .flatMap((q) => q.parameters)
      .filter((v) => typeof v === 'string' && v.startsWith('control.'));
    expect(actions).toHaveLength(100);
  });

  it('carries no payload text: a free-text field in p never reaches the event', async () => {
    const u = controlUnit();
    const host = u.member('host');
    const t = u.member('editor');
    const canary = 'CANARY-control-note-7f3a';
    await u.send(host.conn, u.ctl('control.kick', { member: t.mid, code: 'abuse', note: canary }));
    await u.send(
      host.conn,
      u.ctl('control.policy', {
        auto_approve: 'ask',
        share_history: false,
        queue_limit: 1,
        [canary]: canary,
      }),
    );
    await u.send(host.conn, u.ctl('control.end', { code: canary }));
    expect(u.audited).toHaveLength(3);
    expect(JSON.stringify(u.audited)).not.toContain(canary);
    expect(u.log.raw()).not.toContain(canary);
  });
});
