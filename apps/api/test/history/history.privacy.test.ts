/**
 * What the history store may keep (B055; tests "history.privacy.test.ts"):
 *
 * - `history_index` has exactly CT-RESUME's columns: a column outside the allow-list fails this
 *   test (acceptance 5; DATABASE_URL);
 * - hybrid kinds keep only the contract's clear fields of `p` with `ct`; clear kinds keep `p`;
 *   encrypted kinds keep no `p` and a non-empty `p` is refused; `presence`, `sys.*` and acks are
 *   never stored (acceptance 6, guardrails);
 * - blob keys hold only the session id and numbers;
 * - nothing the writer or the routes log contains `ct` or a payload (log scrubbing).
 */
import { EVENT_CATALOGUE } from '@centcom/contracts';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  HistoryFrameRefused,
  HistoryWriter,
  historyBlobKey,
  parseBlobKey,
  toStoredFrame,
} from '../../src/modules/history/index.js';
import { captureLogger } from '../helpers.js';
import { ADMIN_URL, migratedDatabase } from '../notifications/dispatcher/postgres.js';
import { fixture, newId, sequenced } from './helpers.js';

/** CT-RESUME: seq, id, from, ts, kind-class, size, kid, blob key (plus the session). */
const ALLOWED_COLUMNS = [
  'blob_key',
  'kid',
  'kind_class',
  'member_id',
  'msg_id',
  'seq',
  'session_id',
  'size',
  'ts',
];

describe.runIf(ADMIN_URL !== undefined)('the history_index schema', () => {
  it('has exactly the allowed columns (acceptance 5)', async () => {
    const test = await migratedDatabase(2);
    try {
      const rows = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'history_index' order by 1
      `.execute(test.db);
      expect(rows.rows.map((r) => r.column_name)).toEqual(ALLOWED_COLUMNS);
    } finally {
      await test.drop();
    }
  });
});

describe('toStoredFrame', () => {
  const sid = newId('ses');

  it('keeps only the contract’s clear fields of a hybrid kind, with ct (acceptance 6)', () => {
    const frame = sequenced(sid, 1, { kind: 'approval.request' });
    const withExtra = {
      ...frame,
      p: { ...(frame['p'] as object), summary: 'rm -rf /secret/path' },
    };
    const result = toStoredFrame(withExtra);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clear = EVENT_CATALOGUE['approval.request'].clearFields;
    expect(Object.keys(result.frame.p ?? {}).sort()).toEqual([...clear].sort());
    expect(JSON.stringify(result.frame)).not.toContain('secret/path');
    expect(result.frame.ct).toEqual(frame['ct']);
    expect(result.frame.kid).toBe('k1');
  });

  it('keeps p of a clear kind, and no p of an encrypted one', () => {
    const clear = toStoredFrame(sequenced(sid, 1, { kind: 'agent.state' }));
    expect(clear.ok && clear.frame.p).toEqual(fixture('agent.state')['p']);
    expect(clear.ok && clear.frame.ct).toBeNull();
    const encrypted = toStoredFrame(sequenced(sid, 2));
    expect(encrypted.ok && encrypted.frame.p).toBeNull();
  });

  it('refuses an encrypted kind that carries p, and malformed frames', () => {
    expect(toStoredFrame({ ...sequenced(sid, 1), p: { text: 'hello' } })).toEqual({
      ok: false,
      reason: 'encrypted_with_p',
    });
    expect(toStoredFrame({ ...sequenced(sid, 1), p: {} }).ok).toBe(true);
    for (const bad of [
      { seq: 0 },
      { seq: 1.5 },
      { id: 'nope' },
      { from: 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W' },
      { ts: 'yesterday' },
      { ct: { alg: 'x' } },
      { sig: 'not base64url!' },
      { k: 5 },
      { p: [] },
    ]) {
      expect(toStoredFrame({ ...sequenced(sid, 1), ...bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('never keeps presence, sys frames or acks; keeps only ct of an unknown kind', () => {
    for (const t of ['presence', 'sys.ping', 'sys.hello', 'ack']) {
      expect(toStoredFrame({ ...sequenced(sid, 1), t })).toEqual({
        ok: false,
        reason: 'ephemeral',
      });
    }
    const unknown = toStoredFrame({ ...sequenced(sid, 1), k: 'hologram.wave', p: { text: 'hi' } });
    expect(unknown.ok && unknown.frame.p).toBeNull();
    expect(unknown.ok && unknown.frame.k).toBe('hologram.wave');
  });

  it('accepts server frames (from srv)', () => {
    expect(toStoredFrame({ ...sequenced(sid, 1, { kind: 'agent.state' }), from: 'srv' }).ok).toBe(
      true,
    );
  });
});

describe('blob keys', () => {
  it('hold only the session id and numbers', () => {
    const sid = newId('ses');
    expect(historyBlobKey(sid, 1, 500)).toBe(`history/${sid}/1-500.bin`);
    expect(parseBlobKey(historyBlobKey(sid, 7, 9))).toEqual({ sid, first: 7, last: 9 });
    expect(() => historyBlobKey('ses_bad/../x', 1, 2)).toThrow(TypeError);
    expect(() => historyBlobKey(sid, 3, 2)).toThrow(TypeError);
    expect(parseBlobKey('history/ses_x/1-2.bin')).toBeNull();
    expect(parseBlobKey(`history/${sid}/9-2.bin`)).toBeNull();
  });
});

describe('log scrubbing', () => {
  it('logs no ct and no payload when a frame is refused or a write fails', async () => {
    const log = captureLogger();
    const failing = { append: () => Promise.reject(new Error('down')) };
    const writer = new HistoryWriter({
      store: failing,
      attempts: 1,
      logger: log.logger,
      setTimer: (fn) => {
        queueMicrotask(fn);
        return { cancel: () => undefined };
      },
    });
    const sid = newId('ses');
    const frame = sequenced(sid, 1, { c: 'CIPHERTEXTMARKER' });
    await expect(
      writer.add(sid, { ...frame, p: { text: 'PLAINTEXTMARKER' } }),
    ).rejects.toBeInstanceOf(HistoryFrameRefused);
    await expect(writer.add(sid, frame)).rejects.toThrow('down');
    const raw = log.raw();
    expect(raw).toContain('history.frame_refused');
    expect(raw).toContain('history.append_failed');
    expect(raw).not.toContain('CIPHERTEXTMARKER');
    expect(raw).not.toContain('PLAINTEXTMARKER');
  });
});
