/**
 * A TCP fault proxy for the chaos tests (B096): sits between the API and Postgres or Redis and
 * injects the faults a network and a dying server produce, with no root and no extra container:
 *
 * - `pass`: bytes flow both ways.
 * - `refuse`: existing connections are destroyed and new ones are closed at once (server down).
 * - `blackhole`: connections are accepted but nothing is forwarded (a partition, a hung server).
 * - `delay`: every chunk is forwarded after `delayMs` (a slow disk or a slow network), in order.
 */
import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

export type ProxyMode = 'pass' | 'refuse' | 'blackhole' | 'delay';

export class TcpProxy {
  #mode: ProxyMode = 'pass';
  #delayMs = 0;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  port = 0;

  constructor(
    private readonly target: { host: string; port: number },
    private readonly listenPort = 0,
  ) {}

  async start(): Promise<void> {
    this.#server = createServer((client) => this.#accept(client));
    this.#server.listen(this.listenPort, '127.0.0.1');
    await once(this.#server, 'listening');
    this.port = (this.#server.address() as { port: number }).port;
  }

  /** Switches the fault. `refuse` and `blackhole` cut the connections that exist. */
  set(mode: ProxyMode, delayMs = 0): void {
    this.#mode = mode;
    this.#delayMs = delayMs;
    if (mode === 'refuse' || mode === 'blackhole') {
      for (const s of this.#sockets) s.destroy();
      this.#sockets.clear();
    }
  }

  #track(socket: Socket): void {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => undefined);
  }

  #accept(client: Socket): void {
    this.#track(client);
    if (this.#mode === 'refuse') return void client.destroy();
    if (this.#mode === 'blackhole') {
      client.on('data', () => undefined); // swallowed
      return;
    }
    const upstream = createConnection(this.target);
    this.#track(upstream);
    const pipe = (from: Socket, to: Socket): void => {
      let tail = Promise.resolve();
      from.on('data', (chunk: Buffer) => {
        if (this.#mode === 'blackhole') return;
        const wait = this.#mode === 'delay' ? this.#delayMs : 0;
        tail = tail.then(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                if (!to.destroyed) to.write(chunk);
                resolve();
              }, wait);
            }),
        );
      });
      from.on('close', () => to.destroy());
    };
    pipe(client, upstream);
    pipe(upstream, client);
  }

  async stop(): Promise<void> {
    this.set('refuse');
    this.#server?.close();
    if (this.#server !== undefined) await once(this.#server, 'close').catch(() => undefined);
  }
}

/** `url` with its host and port replaced by the proxy's. */
export function through(url: string, proxy: TcpProxy): string {
  const u = new URL(url);
  u.hostname = '127.0.0.1';
  u.port = String(proxy.port);
  return u.toString();
}

/** `host:port` of a Postgres or Redis URL. */
export function targetOf(url: string): { host: string; port: number } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || (u.protocol.startsWith('redis') ? 6379 : 5432)),
  };
}
