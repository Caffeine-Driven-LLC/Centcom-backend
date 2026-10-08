/**
 * SimFleet (B011): many simulated clients at once, up to the contract's 50 members per session.
 * Connects them concurrently; if any fails, closes the ones that made it and rethrows.
 *
 * Owns: starting and stopping a group of SimClients. Load tests at scale are a later lane.
 */
import { SimClient, type ConnectOpts, type CloseInfo } from './client.js';
import type { Frame } from './frames.js';

/** The most clients in a fleet (members per session, CT-WS-ENVELOPE). */
export const MAX_FLEET = 50;

/** A group of connected SimClients. */
export class SimFleet {
  private constructor(
    /** The clients, in spawn order. */
    readonly clients: readonly SimClient[],
  ) {}

  /** Connects `n` clients (1-50) with the options `make(i)` returns, all at once. */
  static async spawn(
    n: number,
    make: (i: number) => ConnectOpts | Promise<ConnectOpts>,
  ): Promise<SimFleet> {
    if (!Number.isInteger(n) || n < 1 || n > MAX_FLEET) {
      throw new RangeError(`SimFleet.spawn: ${n} clients; a fleet has 1 to ${MAX_FLEET}`);
    }
    const settled = await Promise.allSettled(
      Array.from({ length: n }, async (_, i) => SimClient.connect(await make(i))),
    );
    const clients = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      await Promise.allSettled(clients.map((client) => client.close()));
      throw failure.reason;
    }
    return new SimFleet(clients);
  }

  /** How many clients. */
  get size(): number {
    return this.clients.length;
  }

  /** The client at `i`. */
  at(i: number): SimClient {
    const client = this.clients[i];
    if (client === undefined)
      throw new RangeError(`SimFleet: no client ${i} in a fleet of ${this.size}`);
    return client;
  }

  /** For every client, the first frame matching `pred` (each wait bounded by `timeoutMs`). */
  waitForAll(pred: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame[]> {
    return Promise.all(this.clients.map((client) => client.waitFor(pred, timeoutMs)));
  }

  /** Closes every client. */
  async closeAll(code = 1000): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close(code)));
  }

  /** How each client's connection ended (undefined for open ones). */
  closeInfos(): (CloseInfo | undefined)[] {
    return this.clients.map((client) => client.closeInfo);
  }
}
