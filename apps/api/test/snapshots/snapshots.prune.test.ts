/**
 * B056 pruning: keep the newest 3 (acceptance 4), expire uploads pending for 15 min (acceptance
 * 7), the order (row marked, object, then row) and a prune that stops halfway (failure modes),
 * idempotent prunes, and purgeSession for B090.
 */
import { describe, expect, it } from 'vitest';
import { KEEP_COMMITTED, PENDING_TTL_MS, snapshotKey } from '../../src/modules/snapshots/ports.js';
import { ciphertext, snapshotEnv } from './helpers.js';

describe('keep the newest 3 (acceptance 4)', () => {
  it('after seq 100, 200, 300, 400 only the three newest remain; a 5th commit prunes again', async () => {
    const env = snapshotEnv();
    const made = [];
    for (const seq of [100, 200, 300, 400]) {
      made.push(await env.snapshot(seq));
      env.clock.now += 1000;
    }
    const oldest = made[0]?.grant.snp ?? '';
    expect(env.rows.rows.has(oldest)).toBe(false);
    expect(env.store.blobs.objects.has(snapshotKey(env.sid, oldest))).toBe(false);
    const left = [...env.rows.rows.values()].map((r) => r.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(left).toEqual([200, 300, 400]);
    expect(env.store.blobs.objects.size).toBe(KEEP_COMMITTED);

    await env.snapshot(500);
    const after = [...env.rows.rows.values()].map((r) => r.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(after).toEqual([300, 400, 500]);
    expect(env.store.blobs.objects.has(snapshotKey(env.sid, made[1]?.grant.snp ?? ''))).toBe(false);
    expect((await env.service.latest(env.sid))?.descriptor.seq).toBe(500);
  });

  it('deletes the object before the row', async () => {
    const env = snapshotEnv();
    for (const seq of [1, 2, 3]) await env.snapshot(seq);
    env.store.blobs.calls.length = 0;
    const order: string[] = [];
    const remove = env.rows.remove.bind(env.rows);
    env.rows.remove = (snps) => {
      order.push('row');
      return remove(snps);
    };
    const del = env.store.objects.delete.bind(env.store.objects);
    env.store.objects.delete = (keys) => {
      order.push('object');
      return del(keys);
    };
    await env.snapshot(4);
    expect(order).toEqual(['object', 'row']);
  });

  it('keeps a lower seq committed after 3 higher ones; the latest is never pruned', async () => {
    const env = snapshotEnv();
    const made = [];
    for (const seq of [200, 300, 400]) {
      made.push(await env.snapshot(seq));
      env.clock.now += 1000;
    }
    const low = await env.snapshot(150);
    expect(env.rows.rows.get(low.grant.snp)?.state).toBe('committed');
    expect(env.store.blobs.objects.has(snapshotKey(env.sid, low.grant.snp))).toBe(true);
    // Kept: the latest (400) and the two most recent commits (150, 300); 200 went.
    const left = [...env.rows.rows.values()].map((r) => r.seq).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(left).toEqual([150, 300, 400]);
    expect((await env.service.latest(env.sid))?.descriptor.seq).toBe(400);
    for (const seq of [10, 20, 30]) {
      env.clock.now += 1000;
      await env.snapshot(seq);
    }
    expect((await env.service.latest(env.sid))?.descriptor.seq).toBe(400);
  });

  it('never deletes the only committed snapshot', async () => {
    const env = snapshotEnv();
    await env.snapshot(10);
    await env.service.pruner.pruneSession(env.sid);
    await env.service.pruner.prune();
    expect((await env.service.latest(env.sid))?.descriptor.seq).toBe(10);
  });
});

describe('expired uploads (acceptance 7)', () => {
  it('deletes uploads pending over 15 min, objects included; younger ones are untouched', async () => {
    const env = snapshotEnv();
    const old = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    env.store.upload(old.uploadUrl, ciphertext(10).bytes, new Date(env.clock.now));
    env.clock.now += 10 * 60_000;
    const young = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    env.store.upload(young.uploadUrl, ciphertext(10).bytes, new Date(env.clock.now));
    env.clock.now += PENDING_TTL_MS - 10 * 60_000 + 1;

    expect(await env.service.pruner.prune()).toEqual({ expired: 1, retried: 0 });
    expect(env.rows.rows.has(old.snp)).toBe(false);
    expect(env.store.blobs.objects.has(snapshotKey(env.sid, old.snp))).toBe(false);
    expect(env.rows.rows.get(young.snp)?.state).toBe('pending');
    expect(env.store.blobs.objects.has(snapshotKey(env.sid, young.snp))).toBe(true);
    // Idempotent: nothing more to do.
    expect(await env.service.pruner.prune()).toEqual({ expired: 0, retried: 0 });
  });

  it("a commit expires its own session's stale uploads (no scheduler needed)", async () => {
    const env = snapshotEnv();
    const old = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    env.store.upload(old.uploadUrl, ciphertext(10).bytes, new Date(env.clock.now));
    env.clock.now += PENDING_TTL_MS + 1;
    await env.snapshot(1);
    expect(env.rows.rows.has(old.snp)).toBe(false);
    expect(env.store.blobs.objects.has(snapshotKey(env.sid, old.snp))).toBe(false);
  });

  it('a pending upload with no object yet is expired too', async () => {
    const env = snapshotEnv();
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    env.clock.now += PENDING_TTL_MS + 1;
    expect(await env.service.pruner.prune()).toEqual({ expired: 1, retried: 0 });
    expect(env.rows.rows.has(grant.snp)).toBe(false);
  });

  it('a commit after its upload expired is 404 snapshot_missing', async () => {
    const env = snapshotEnv();
    const data = ciphertext(10);
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 10 });
    env.store.upload(grant.uploadUrl, data.bytes, new Date(env.clock.now));
    env.clock.now += PENDING_TTL_MS + 1;
    await env.service.pruner.prune();
    await expect(
      env.service.commit(
        env.sid,
        grant.snp,
        { seq: 1, sha256: data.sha256, size: 10, kid: 'k1' },
        { userId: env.host },
      ),
    ).rejects.toMatchObject({ code: 'snapshot_missing' });
  });
});

describe('a prune that stops halfway (failure modes)', () => {
  it('leaves the row deleting (never served), and the next prune finishes it', async () => {
    const env = snapshotEnv();
    for (const seq of [100, 200, 300]) await env.snapshot(seq);
    env.rows.fail.remove = true;
    // The commit still answers 200; its prune stopped after deleting the oldest object.
    const fourth = await env.snapshot(50);
    expect(fourth.descriptor.seq).toBe(50);
    const stuck = [...env.rows.rows.values()].filter((r) => r.state === 'deleting');
    expect(stuck.map((r) => r.seq)).toEqual([100]);
    expect(env.store.blobs.objects.has(stuck[0]?.blobKey ?? '')).toBe(false);
    expect(env.captured.raw()).toContain('snapshot.prune_incomplete');
    // GET never serves it.
    expect((await env.service.latest(env.sid))?.descriptor.seq).toBe(300);
    env.rows.fail.remove = false;
    expect(await env.service.pruner.prune()).toEqual({ expired: 0, retried: 1 });
    expect([...env.rows.rows.values()].every((r) => r.state === 'committed')).toBe(true);
    expect(await env.service.pruner.prune()).toEqual({ expired: 0, retried: 0 });
  });

  it('an object store failure keeps the rows deleting until a later prune', async () => {
    const env = snapshotEnv();
    const grant = await env.service.begin(env.sid, { userId: env.host }, { size: 1 });
    env.store.upload(grant.uploadUrl, new Uint8Array(1), new Date(env.clock.now));
    env.clock.now += PENDING_TTL_MS + 1;
    env.store.blobs.failures.delete = 1;
    await expect(env.service.pruner.prune()).rejects.toThrow();
    expect(env.rows.rows.get(grant.snp)?.state).toBe('deleting');
    expect(await env.service.pruner.prune()).toEqual({ expired: 0, retried: 1 });
    expect(env.rows.rows.size).toBe(0);
    expect(env.store.blobs.objects.size).toBe(0);
  });
});

describe('purgeSession (for B090)', () => {
  it('deletes every snapshot, pending uploads and stray objects included', async () => {
    const env = snapshotEnv();
    await env.snapshot(1);
    await env.snapshot(2);
    const pending = await env.service.begin(env.sid, { userId: env.host }, { size: 3 });
    env.store.upload(pending.uploadUrl, new Uint8Array(3), new Date(env.clock.now));
    env.store.blobs.objects.set(`snapshots/${env.sid}/stray.bin`, new Uint8Array(1));
    const other = snapshotEnv();
    await other.snapshot(1);
    await env.service.purgeSession(env.sid);
    expect(env.rows.rows.size).toBe(0);
    expect([...env.store.blobs.objects.keys()]).toEqual([]);
    expect(await env.service.latest(env.sid)).toBeNull();
    // Repeating it is harmless.
    await env.service.purgeSession(env.sid);
    expect(await other.service.latest(other.sid)).not.toBeNull();
  });
});
