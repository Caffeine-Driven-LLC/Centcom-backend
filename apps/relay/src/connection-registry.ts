/**
 * Connections (B037): every open WebSocket of this relay, with what later lanes need to find it
 * (its session once the handshake names one) and nothing that identifies the client: the remote
 * address is kept only as a keyed hash (a per-process random key), so it groups connections from
 * one address without storing the address. The registry holds at most `max` entries (the
 * connection cap); every close path removes the entry.
 *
 * Owns: the entries and the cap. Must not: keep an entry after its connection closed.
 */
import { createHmac, randomBytes } from 'node:crypto';

/** Where a connection is in its life. */
export type ConnectionState = 'open' | 'authenticated' | 'closing';

/** One connection. */
export interface ConnectionEntry {
  /** Random, process-local. */
  readonly id: string;
  /** HMAC-SHA256 of the remote address under a per-process key, 16 hex characters. */
  readonly remoteHash: string;
  state: ConnectionState;
  /** The session, once the handshake (B038) names it. */
  sessionId: string | null;
  /** The member (`mem_…`) the handshake admitted, from the live record; stamped as `from` (B041). */
  memberId: string | null;
  /** The device (`dev_…`) of the ticket the handshake admitted (B045: cross-node supersede). */
  deviceId: string | null;
  readonly createdAt: Date;
}

/** Options for ConnectionRegistry. */
export interface ConnectionRegistryOptions {
  /** RELAY_MAX_CONNECTIONS. */
  max: number;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
}

/** The open connections. */
export class ConnectionRegistry {
  readonly max: number;
  readonly #entries = new Map<string, ConnectionEntry>();
  readonly #clock: () => number;
  readonly #key = randomBytes(32);
  #emptyWaiters: (() => void)[] = [];

  constructor(options: ConnectionRegistryOptions) {
    if (!Number.isSafeInteger(options.max) || options.max < 1) {
      throw new TypeError('ConnectionRegistry: max must be a positive integer');
    }
    this.max = options.max;
    this.#clock = options.clock ?? Date.now;
  }

  /** Open connections. */
  get size(): number {
    return this.#entries.size;
  }

  /** True when one more connection would pass the cap. */
  get full(): boolean {
    return this.#entries.size >= this.max;
  }

  /** Adds a connection from `remoteAddress`; throws a RangeError when full (check `full`). */
  add(remoteAddress: string | undefined): ConnectionEntry {
    if (this.full) throw new RangeError('ConnectionRegistry: the connection cap is reached');
    const entry: ConnectionEntry = {
      id: randomBytes(12).toString('base64url'),
      remoteHash: createHmac('sha256', this.#key)
        .update(remoteAddress ?? '')
        .digest('hex')
        .slice(0, 16),
      state: 'open',
      sessionId: null,
      memberId: null,
      deviceId: null,
      createdAt: new Date(this.#clock()),
    };
    this.#entries.set(entry.id, entry);
    return entry;
  }

  /** The entry, or undefined. */
  get(id: string): ConnectionEntry | undefined {
    return this.#entries.get(id);
  }

  /** Removes the entry (idempotent); true when it was there. */
  remove(id: string): boolean {
    const removed = this.#entries.delete(id);
    if (removed && this.#entries.size === 0) {
      const waiters = this.#emptyWaiters;
      this.#emptyWaiters = [];
      for (const resolve of waiters) resolve();
    }
    return removed;
  }

  /** The entries, oldest first. */
  entries(): ConnectionEntry[] {
    return [...this.#entries.values()];
  }

  /** Resolves once no connection is open (at once when none is). */
  whenEmpty(): Promise<void> {
    if (this.#entries.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#emptyWaiters.push(resolve));
  }
}
