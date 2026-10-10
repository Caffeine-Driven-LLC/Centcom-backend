/**
 * B056 privacy (card tests: "the lane never reads bytes beyond hashing and never logs url or hash
 * of content"; guardrails): the bytes are only streamed through the hash, 64 KiB at a time, and
 * never fetched whole; no log line or audit event carries a URL, a signature, a content hash or
 * the bytes (metric labels are fixed enums: op, outcome, reason); the table stores only the
 * descriptor's columns.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HASH_CHUNK_BYTES, snapshotKey } from '../../src/modules/snapshots/ports.js';
import { ciphertext, snapshotEnv } from './helpers.js';

describe('snapshot privacy', () => {
  it('reads an object only as a stream for its hash, in chunks of at most 64 KiB', async () => {
    const env = snapshotEnv();
    const sizes: number[] = [];
    const read = env.store.objects.read.bind(env.store.objects);
    env.store.objects.read = async function* (key) {
      for await (const chunk of read(key)) {
        sizes.push(chunk.byteLength);
        yield chunk;
      }
    };
    const { grant } = await env.snapshot(1, 1_000_000);
    expect(env.store.reads).toEqual([snapshotKey(env.sid, grant.snp)]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(HASH_CHUNK_BYTES);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1_000_000);
    // B055's whole-object GET is never used.
    expect(env.store.blobs.calls.filter((c) => c.startsWith('get '))).toEqual([]);
  });

  it('stops reading as soon as an object is larger than declared', async () => {
    const env = snapshotEnv();
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    env.store.blobs.objects.set(
      snapshotKey(env.sid, grant.snp),
      new Uint8Array(HASH_CHUNK_BYTES * 8),
    );
    let chunks = 0;
    const read = env.store.objects.read.bind(env.store.objects);
    env.store.objects.read = async function* (key) {
      for await (const chunk of read(key)) {
        chunks += 1;
        yield chunk;
      }
    };
    await expect(
      env.service.commit(
        env.sid,
        grant.snp,
        { seq: 1, sha256: ciphertext(1).sha256, size: 10, kid: 'k1' },
        { userId: env.host },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(chunks).toBe(1);
  });

  it('never logs or audits a URL, a signature, a hash or content', async () => {
    const env = snapshotEnv();
    const secrets: string[] = [];
    const ok = await env.snapshot(1, 512);
    secrets.push(ok.grant.uploadUrl, ok.data.sha256, ok.data.sha256.slice(7));
    const latest = await env.service.latestFor(env.sid, { userId: env.viewer });
    secrets.push(latest.downloadUrl);
    // A mismatch, a store failure and a failed prune, all logged.
    const bad = ciphertext(16);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 16 });
    secrets.push(grant.uploadUrl, bad.sha256.slice(7));
    env.store.upload(grant.uploadUrl, bad.bytes, new Date(env.clock.now));
    await env.service
      .commit(
        env.sid,
        grant.snp,
        { seq: 2, sha256: ciphertext(1).sha256, size: 16, kid: 'k1' },
        {
          userId: env.host,
        },
      )
      .catch(() => undefined);
    env.store.failures.read = true;
    env.store.upload(grant.uploadUrl, bad.bytes, new Date(env.clock.now));
    await env.service
      .commit(
        env.sid,
        grant.snp,
        { seq: 2, sha256: bad.sha256, size: 16, kid: 'k1' },
        {
          userId: env.host,
        },
      )
      .catch(() => undefined);
    env.store.failures.read = false;
    env.store.blobs.failures.delete = 1;
    for (const seq of [3, 4, 5]) await env.snapshot(seq, 8).catch(() => undefined);

    const logs = env.captured.raw();
    expect(logs).toContain('snapshot.verify_failed');
    const audits = JSON.stringify(env.audit.events);
    for (const text of [logs, audits]) {
      expect(text).not.toContain('X-Amz-Signature');
      expect(text).not.toContain('X-Amz-Credential');
      expect(text).not.toContain('objects.test');
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
    expect(Buffer.from(logs).includes(Buffer.from(ok.data.bytes.subarray(0, 32)))).toBe(false);
    // Audit meta holds ids, the seq and the size only.
    for (const event of env.audit.events) {
      expect(
        Object.keys(event.meta ?? {}).every((k) => ['session_id', 'seq', 'size'].includes(k)),
      ).toBe(true);
    }
  });

  it('the table stores only the descriptor columns', () => {
    const sql = readFileSync(
      new URL('../../../../packages/db/migrations/20260102004600_snapshots.sql', import.meta.url),
      'utf8',
    );
    const body = /create table snapshot \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
    const columns = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z][a-z0-9_]* (text|bigint|integer|timestamptz)\b/.test(line))
      .map((line) => line.split(' ')[0]);
    expect(columns).toEqual([
      'snp',
      'session_id',
      'state',
      'seq',
      'size',
      'sha256',
      'kid',
      'blob_key',
      'created_at',
      'committed_at',
    ]);
  });
});
