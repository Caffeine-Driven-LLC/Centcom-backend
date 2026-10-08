/**
 * Ticket verification timing (B038 acceptance 9), run in a child process by
 * handshake.ticket.test.ts so the test runner's coverage does not distort it. Reads `{runs}` from
 * stdin, mints that many tickets with one key, warms the JWKS cache, verifies each once and prints
 * `{p95, fetches}` (milliseconds; JWKS fetches made).
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { JwksCache } from '../../src/handshake/jwks.js';
import { verifyRelayTicket } from '../../src/handshake/ticket.js';
import { mintTicket, signingKey, stubJwks, ticketFor } from './helpers.js';

const { runs } = JSON.parse(readFileSync(0, 'utf8')) as { runs: number };
const key = signingKey();
const jwks = stubJwks([key.jwk]);
const cache = new JwksCache({ url: 'https://api.centcom.test/jwks', fetch: jwks.fetcher });
const tickets = await Promise.all(
  Array.from({ length: runs + 20 }, () => mintTicket(key, ticketFor())),
);
for (const ticket of tickets.slice(0, 20)) {
  await verifyRelayTicket(ticket, { jwks: cache, nowMs: Date.now() });
}
const times: number[] = [];
for (const ticket of tickets.slice(20)) {
  const start = performance.now();
  await verifyRelayTicket(ticket, { jwks: cache, nowMs: Date.now() });
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
process.stdout.write(JSON.stringify({ p95, fetches: jwks.state.calls }));
