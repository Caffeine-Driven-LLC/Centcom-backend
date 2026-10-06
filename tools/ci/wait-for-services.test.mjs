// @ts-check
/** B002 integration guard: service URLs parse, and TCP readiness respects its deadline. */
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { endpointOf, waitForTcp } from './wait-for-services.mjs';

describe('endpointOf', () => {
  it.each([
    ['postgres://u:p@localhost:5432/db', { host: 'localhost', port: 5432 }],
    ['postgresql://u:p@db.internal/db', { host: 'db.internal', port: 5432 }],
    ['redis://localhost:6379/0', { host: 'localhost', port: 6379 }],
    ['redis://cache', { host: 'cache', port: 6379 }],
  ])('%s', (url, expected) => expect(endpointOf(url)).toEqual(expected));

  it.each([undefined, '', 'not a url', 'http://localhost', 'mysql://localhost/db'])(
    'rejects %s',
    (url) => expect(endpointOf(url)).toBeNull(),
  );
});

describe('waitForTcp', () => {
  it('resolves true once the port accepts connections', async () => {
    const server = createServer((s) => s.end());
    await new Promise((/** @type {(v?: unknown) => void} */ r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      expect(await waitForTcp({ host: '127.0.0.1', port: address.port }, Date.now() + 5_000)).toBe(
        true,
      );
    } finally {
      server.close();
    }
  });

  it('resolves false when the deadline passes first', { timeout: 10_000 }, async () => {
    const server = createServer();
    await new Promise((/** @type {(v?: unknown) => void} */ r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    await new Promise((r) => server.close(r)); // the port is now closed
    expect(await waitForTcp({ host: '127.0.0.1', port: address.port }, Date.now() + 1_500)).toBe(
      false,
    );
  });
});
