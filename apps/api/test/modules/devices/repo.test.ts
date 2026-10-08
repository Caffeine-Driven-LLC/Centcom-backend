/**
 * The store's error mapping (B020 failure modes "DB failure mid-revoke" and "peer lookup query
 * slow"): an unreachable database or a statement cancelled by `statement_timeout` becomes a 503
 * with no details from the driver, never a 500; any other error passes through unchanged. Runs on
 * a scripted driver, so it needs no database.
 */
import { isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { deviceStoreFromDb, isUnavailable } from '../../../src/modules/devices/repo.js';
import { scriptedDb } from '../users/helpers.js';
import { newId } from './helpers.js';

const timeout = (): Error =>
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
const refused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), { code: 'ECONNREFUSED' });

describe('deviceStoreFromDb', () => {
  it.each([
    ['a statement timeout (slow peer lookup)', timeout],
    ['a refused connection', refused],
  ])('answers %s with 503 and no driver detail', async (_case, failure) => {
    const store = deviceStoreFromDb(scriptedDb(() => failure()).db);
    const calls = [
      () => store.shareSession(newId('usr'), newId('usr')),
      () => store.findById(newId('dev')),
      () => store.markRevoked(newId('dev'), newId('usr'), new Date()),
      () => store.touch(newId('dev'), new Date(), 1000),
    ];
    for (const call of calls) {
      const error = await call().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(isAppError(error) && error.status).toBe(503);
      expect(JSON.stringify(error)).not.toContain('10.0.0.7');
    }
  });

  it('passes other errors through', async () => {
    const boom = new Error('syntax error');
    const store = deviceStoreFromDb(scriptedDb(() => boom).db);
    await expect(store.findById(newId('dev'))).rejects.toBe(boom);
  });

  it('reads through on success', async () => {
    const { db, statements } = scriptedDb(() => ({ rows: [{ one: 1 }] }));
    const store = deviceStoreFromDb(db);
    expect(await store.shareSession(newId('usr'), newId('usr'))).toBe(true);
    expect(statements[0]).toContain('session_members');
  });
});

describe('isUnavailable', () => {
  it('knows outages and timeouts from other errors', () => {
    expect(isUnavailable(timeout())).toBe(true);
    expect(isUnavailable(refused())).toBe(true);
    expect(isUnavailable(new Error('duplicate key'))).toBe(false);
    expect(isUnavailable(null)).toBe(false);
  });
});
