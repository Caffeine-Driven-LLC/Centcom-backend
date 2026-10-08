/**
 * Shared set-up for the simulator tests: a LoopbackRelay per test, members with fresh test
 * tickets, and clean-up of every relay and client after each test.
 */
import { join } from 'node:path';
import { createIdGenerator } from '@centcom/contracts';
import { afterEach } from 'vitest';
import {
  LoopbackRelay,
  mintTestTicket,
  SimClient,
  type ConnectOpts,
  type Frame,
  type LoopbackRelayOptions,
  type SessionRole,
} from '../../src/sim/index.js';

/** CT-IDS ids for tests. */
export const newId = createIdGenerator();

/** The repository's contracts directory. */
export const CONTRACTS = join(import.meta.dirname, '..', '..', '..', '..', 'contracts');

const cleanups: (() => Promise<unknown>)[] = [];

/** Closes what the test opened (call at the top of a test file). */
export function useCleanup(): void {
  afterEach(async () => {
    await Promise.allSettled(
      cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => cleanup()),
    );
  });
}

/** A LoopbackRelay closed after the test. */
export async function startRelay(opts?: LoopbackRelayOptions): Promise<LoopbackRelay> {
  const relay = await LoopbackRelay.start(opts);
  cleanups.push(() => relay.close());
  return relay;
}

/** A session member with a device, and a fresh test ticket per call of `ticket`. */
export interface Member {
  sid: string;
  mid: string;
  dev: string;
  role: SessionRole;
  ticket: () => Promise<string>;
}

export function member(sid: string, role: SessionRole = 'editor'): Member {
  const mid = newId('mem');
  const dev = newId('dev');
  return { sid, mid, dev, role, ticket: () => mintTestTicket({ sid, mid, dev, role }) };
}

/** A SimClient for `who` on `relay`, closed after the test. */
export async function connect(
  relay: LoopbackRelay,
  who: Member,
  opts: Partial<ConnectOpts> = {},
): Promise<SimClient> {
  const client = await SimClient.connect({ url: relay.url, ticket: who.ticket, ...opts });
  cleanups.push(() => client.close());
  return client;
}

/** A valid `reaction` payload (a clear, sequenced kind). */
export const reaction = (target = newId('msg')): Record<string, unknown> => ({
  target,
  code: 'thumbs',
  op: 'add',
});

/** The seqs of the sequenced frames of a log, in log order. */
export const seqs = (frames: readonly Frame[]): number[] =>
  frames.flatMap((frame) => (typeof frame.seq === 'number' ? [frame.seq] : []));

/** 1..n */
export const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

/** Sends `n` reactions from `client` at once and waits for every echo. */
export async function sendReactions(
  client: SimClient,
  n: number,
): Promise<{ id: string; seq: number }[]> {
  return Promise.all(Array.from({ length: n }, () => client.send('reaction', reaction())));
}

let pings = 0;

/** Round-trips a ping, so every frame the relay sent before its pong has reached the client. */
export async function roundTrip(client: SimClient): Promise<void> {
  pings += 1;
  const t = pings;
  client.sendRaw(JSON.stringify({ v: 1, t: 'sys.ping', p: { t } }));
  await client.waitFor((frame) => frame.t === 'sys.pong' && frame.p?.['t'] === t);
}
