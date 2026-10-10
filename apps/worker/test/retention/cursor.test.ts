/**
 * The cursor (B090; failure mode "Run exceeds the 30 min budget -> stops cleanly, continues next
 * night"), over an in-memory Redis:
 *
 * - it stores a workspace id with a TTL under `retention:cursor:<policy>`, and null clears it;
 * - reading ignores a value that is not a workspace id; a read or write that fails is logged at
 *   warn (the error's kind only) and the run goes on from the first id;
 * - the walk gives every workspace once: all of them without a cursor; after it, then round from
 *   the first id to it again; and it ends when the cursor's workspace is gone, or when the store
 *   orders ids differently from JavaScript (another collation).
 */
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  createDecideCursor,
  readCursor,
  RETENTION_CURSOR_TTL_MS,
  retentionCursorKey,
  workspacesFrom,
  writeCursor,
  type DecideCursor,
} from '../../src/index.js';
import { captureLogger, newId } from './helpers.js';

/** Pages over `ids` in their given order, `after` excluded. */
const pagesOf =
  (ids: readonly string[]) =>
  (after: string | null, limit: number): Promise<string[]> => {
    const from = after === null ? 0 : ids.indexOf(after) + 1;
    return Promise.resolve(ids.slice(from, from + limit));
  };

async function walk(
  page: (after: string | null, limit: number) => Promise<string[]>,
  start: string | null,
  limit = 2,
): Promise<string[]> {
  const out: string[] = [];
  for await (const id of workspacesFrom(page, start, limit)) out.push(id);
  return out;
}

describe('the cursor', () => {
  it('stores a workspace id with a TTL, and null clears it', async () => {
    const redis = createMemoryRedis();
    const cursor = createDecideCursor(redis.kv);
    const ws = newId('wsp');
    await cursor.set('history', ws);
    expect(await redis.kv.get(retentionCursorKey('history'))).toBe(ws);
    expect(retentionCursorKey('history')).toBe('retention:cursor:history');
    const ttl = await redis.kv.ttl(retentionCursorKey('history'));
    expect(ttl).toBeGreaterThan(RETENTION_CURSOR_TTL_MS - 1000);
    expect(ttl).toBeLessThanOrEqual(RETENTION_CURSOR_TTL_MS);
    expect(await cursor.get('history')).toBe(ws);
    expect(await cursor.get('audit')).toBeNull();
    await cursor.set('history', null);
    expect(await redis.kv.get(retentionCursorKey('history'))).toBeNull();
  });

  it('ignores a value that is not a workspace id, and logs a failed read or write', async () => {
    const redis = createMemoryRedis();
    await redis.kv.set(retentionCursorKey('history'), 'not-a-workspace');
    expect(await readCursor(createDecideCursor(redis.kv), 'history')).toBeNull();

    const captured = captureLogger();
    const broken: DecideCursor = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
    };
    expect(await readCursor(broken, 'history', captured.logger)).toBeNull();
    await expect(
      writeCursor(broken, 'audit', newId('wsp'), captured.logger),
    ).resolves.toBeUndefined();
    expect(captured.lines().filter((l) => l['msg'] === 'retention.cursor_failed')).toEqual([
      expect.objectContaining({ level: 'warn', policy: 'history', step: 'read', error: 'Error' }),
      expect.objectContaining({ level: 'warn', policy: 'audit', step: 'write', error: 'Error' }),
    ]);
    expect(JSON.stringify(captured.lines())).not.toContain('redis down');
  });
});

describe('the walk from the cursor', () => {
  const ids = ['wsp_a', 'wsp_b', 'wsp_c', 'wsp_d', 'wsp_e'];

  it('gives every workspace once, from the first without a cursor', async () => {
    expect(await walk(pagesOf(ids), null)).toEqual(ids);
    expect(await walk(pagesOf([]), null)).toEqual([]);
  });

  it('starts after the cursor and wraps around to it', async () => {
    expect(await walk(pagesOf(ids), 'wsp_b')).toEqual([
      'wsp_c',
      'wsp_d',
      'wsp_e',
      'wsp_a',
      'wsp_b',
    ]);
    expect(await walk(pagesOf(ids), 'wsp_e')).toEqual(ids);
    expect(await walk(pagesOf(ids), 'wsp_d', 10)).toEqual([
      'wsp_e',
      'wsp_a',
      'wsp_b',
      'wsp_c',
      'wsp_d',
    ]);
  });

  it('ends when the cursor workspace is gone', async () => {
    // A store paging by id comparison, the cursor's workspace deleted since.
    const byId = (after: string | null, limit: number): Promise<string[]> =>
      Promise.resolve(ids.filter((id) => after === null || id > after).slice(0, limit));
    expect(await walk(byId, 'wsp_bb')).toEqual(['wsp_c', 'wsp_d', 'wsp_e', 'wsp_a', 'wsp_b']);
  });

  it('ends whatever order the store gives the ids in', async () => {
    // Another collation: the store's order is not JavaScript's.
    const collated = ['wsp_c', 'wsp_A', 'wsp_b', 'wsp_D'];
    expect(await walk(pagesOf(collated), 'wsp_A')).toEqual(['wsp_b', 'wsp_D', 'wsp_c', 'wsp_A']);
  });
});
