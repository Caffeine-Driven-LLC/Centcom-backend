/**
 * The relay server (B037, CT-WS-ENVELOPE "Endpoint and subprotocol"): one Node HTTP server that
 * answers `/healthz` and `/readyz` and upgrades `/v1/ws` to WebSocket with the `centcom.v1`
 * subprotocol.
 *
 * Upgrades are refused with an HTTP status before any WebSocket exists:
 * - another path: 404;
 * - a `ticket` or `token` in the query: 400 (credentials travel in `sys.hello`, never in a URL);
 * - while draining: 503;
 * - a browser `Origin` outside RELAY_ALLOWED_ORIGINS: 403 (no Origin: a non-browser client);
 * - no `centcom.v1` among the offered subprotocols: 400.
 *
 * An accepted connection past the cap (RELAY_MAX_CONNECTIONS), or while a dependency is down, gets
 * a `sys.error` (503 with `retry_after_s`) and close 4503 at once. Otherwise it is registered, its
 * messages run through the frame pipeline, and the connection handlers modules added see it. A
 * handler or stage that throws closes that connection (`sys.error` 500, close 1011), counted,
 * and the process stays up. Messages larger than RELAY_MAX_TRANSPORT_BYTES are refused by the
 * transport (close 1009) before they are buffered.
 *
 * Logs never carry the query string, the subprotocol header or a credential.
 *
 * Owns: the HTTP and WebSocket plumbing, and `startRelay`. Must not: interpret frames (modules do).
 */
import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { newId } from '@centcom/contracts';
import {
  AppError,
  noopMetrics,
  isAppError,
  toProblem,
  type Logger,
  type Metrics,
  type RedisBackend,
} from '@centcom/core';
import { SpanKind, type Tracer } from '@opentelemetry/api';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { buildInfo, type BuildInfo } from './build-info.js';
import { CloseCode, type CloseCodeValue } from './close-codes.js';
import { closeConnection } from './connection/close.js';
import type { RelayConfig } from './config.js';
import { ConnectionRegistry, type ConnectionEntry } from './connection-registry.js';
import { handleHealth, Readiness, type ReadinessProbe } from './health.js';
import {
  closeLabel,
  createRelayMetrics,
  frameLabel,
  RELAY_METRICS,
  type RelayMetrics,
  type UpgradeRefusal,
} from './metrics.js';
import {
  discoverModules,
  registerModules,
  type RelayContext,
  type RelayDb,
  type RelayModule,
} from './modules.js';
import { FramePipeline, type RelayConnection } from './pipeline.js';

/** Where clients connect. */
export const WS_PATH = '/v1/ws';
/** The only subprotocol (CT-WS-ENVELOPE). */
export const SUBPROTOCOL = 'centcom.v1';
/** The `retry_after_s` an overloaded relay asks for. */
export const OVERLOAD_RETRY_AFTER_S = 5;
/** A refused connection that does not finish the closing handshake is cut after this long. */
export const REFUSED_CLOSE_TIMEOUT_MS = 1_000;

/** `{v:1, t:'sys.error', p: <problem>}` for `err` (CT-ERR body; generic for non-AppErrors). */
export function sysError(err: unknown): object {
  return { v: 1, t: 'sys.error', p: toProblem(err, { requestId: newId('req') }) };
}

/** `{v:1, t:'sys.bye', p:{reason}}`. */
export const sysBye = (reason: string): object => ({ v: 1, t: 'sys.bye', p: { reason } });

const text = (data: RawData): string =>
  Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data).toString('utf8');

/** A registered connection. */
class LiveConnection implements RelayConnection {
  constructor(
    readonly ws: WebSocket,
    readonly entry: ConnectionEntry,
  ) {}

  send(frame: object): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  sendText(text: string): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  bufferedBytes(): number {
    return this.ws.bufferedAmount;
  }

  close(code: CloseCodeValue, reason?: string): void {
    this.entry.state = 'closing';
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  onClose(listener: (code: number) => void): void {
    if (this.ws.readyState === WebSocket.CLOSED) {
      listener(1006);
      return;
    }
    this.ws.once('close', (code: number) => listener(code));
  }
}

/** Options for RelayServer. */
export interface RelayServerOptions {
  config: Pick<RelayConfig, 'maxTransportBytes' | 'allowedOrigins'>;
  registry: ConnectionRegistry;
  readiness: Readiness;
  pipeline: FramePipeline;
  logger: Logger;
  metrics?: Metrics;
  /** Traces each connection as one span (B093); none: not traced. */
  tracer?: Tracer;
}

/** The HTTP server, the WebSocket upgrades and the live connections. */
export class RelayServer {
  readonly http: Server;
  readonly #o: RelayServerOptions;
  readonly #wss: WebSocketServer;
  readonly #metrics: RelayMetrics;
  readonly #live = new Map<string, LiveConnection>();
  readonly #handlers: ((connection: RelayConnection) => void)[] = [];

  constructor(options: RelayServerOptions) {
    this.#o = options;
    this.#metrics = createRelayMetrics(options.metrics ?? noopMetrics);
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: options.config.maxTransportBytes,
      perMessageDeflate: false,
      clientTracking: false,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    this.http = createServer((req, res) => {
      if (handleHealth(req, res, options.readiness)) return;
      const status = (req.url ?? '').split('?')[0] === WS_PATH ? 426 : 404;
      res.writeHead(status, { 'content-length': 0, connection: 'close' }).end();
    });
    this.http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.#upgrade(req, socket, head),
    );
  }

  /** Adds a handler run for every accepted connection (modules' `onConnection`). */
  onConnection(handler: (connection: RelayConnection) => void): void {
    this.#handlers.push(handler);
  }

  /** The open connections. */
  connections(): RelayConnection[] {
    return [...this.#live.values()];
  }

  /** Gauges read when metrics are scraped. */
  gauges(): Record<string, number> {
    return { [RELAY_METRICS.connectionsActive]: this.#o.registry.size };
  }

  /** Listens on `port` (0: any free one); resolves the port. Rejects on EADDRINUSE and the like. */
  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.http.once('error', onError);
      this.http.listen(port, host, () => {
        this.http.off('error', onError);
        const address = this.http.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });
  }

  /** From now on: `/readyz` 503 and upgrades 503 (shutdown). */
  beginDrain(): void {
    this.#o.readiness.drain();
  }

  /** Stops listening and cuts what is left of HTTP; resolves when the server is closed. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.http.listening) {
        resolve();
        return;
      }
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  #refuse(socket: Duplex, status: number, reason: UpgradeRefusal): void {
    this.#metrics.upgradeRefused(reason);
    this.#o.logger.info({ reason, status }, 'relay.upgrade_refused');
    const retry = status === 503 ? 'Retry-After: 1\r\n' : '';
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n` +
        `Connection: close\r\nContent-Length: 0\r\n${retry}\r\n`,
    );
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://relay.invalid');
    } catch {
      this.#refuse(socket, 400, 'bad_request');
      return;
    }
    if (url.pathname !== WS_PATH) {
      this.#refuse(socket, 404, 'path');
      return;
    }
    const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    if (keys.includes('ticket') || keys.includes('token')) {
      this.#refuse(socket, 400, 'query_credentials');
      return;
    }
    if (this.#o.readiness.draining) {
      this.#refuse(socket, 503, 'draining');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !this.#o.config.allowedOrigins.includes(origin)) {
      this.#refuse(socket, 403, 'origin');
      return;
    }
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (!offered.includes(SUBPROTOCOL)) {
      this.#refuse(socket, 400, 'subprotocol');
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, req));
  }

  #accept(ws: WebSocket, req: IncomingMessage): void {
    if (this.#o.registry.full || !this.#o.readiness.ready) {
      this.#overloaded(ws);
      return;
    }
    const entry = this.#o.registry.add(req.socket.remoteAddress);
    const connection = new LiveConnection(ws, entry);
    this.#live.set(entry.id, connection);
    this.#metrics.connectionOpened();
    // One span per connection (B093): no per-frame spans, nothing from the frames.
    const span = this.#o.tracer?.startSpan('relay.connection', {
      kind: SpanKind.SERVER,
      attributes: { 'network.protocol.name': 'websocket' },
    });
    ws.on('message', (data, isBinary) => {
      const raw = isBinary ? null : text(data);
      this.#metrics.frameIn(frameLabel(raw));
      this.#o.pipeline
        .run({ connection, raw, state: {} })
        .catch((err: unknown) => this.#failed(connection, err));
    });
    ws.on('close', (code) => {
      this.#o.registry.remove(entry.id);
      this.#live.delete(entry.id);
      this.#metrics.closed(code);
      span?.setAttribute('centcom.close_code', closeLabel(code));
      span?.end();
    });
    // A socket error is followed by 'close', which cleans up.
    ws.on('error', (err) => this.#o.logger.debug({ error: err.name }, 'relay.socket_error'));
    for (const handler of this.#handlers) {
      try {
        handler(connection);
      } catch (err) {
        this.#failed(connection, err);
        return;
      }
    }
  }

  /** Past the cap or not ready: `sys.error` 503 and close 4503. */
  #overloaded(ws: WebSocket): void {
    const error = new AppError('service_unavailable', {
      detail: 'The relay is at capacity; try again shortly.',
      retryAfterS: OVERLOAD_RETRY_AFTER_S,
    });
    ws.on('close', (code) => this.#metrics.closed(code));
    ws.on('error', () => undefined);
    ws.send(JSON.stringify(sysError(error)));
    ws.close(CloseCode.Overloaded);
    setTimeout(() => ws.terminate(), REFUSED_CLOSE_TIMEOUT_MS).unref();
  }

  /** A handler or stage threw: generic `sys.error`, close 1011; the process stays up. */
  #failed(connection: LiveConnection, err: unknown): void {
    this.#metrics.handlerError();
    this.#o.logger.error(
      { error: err instanceof Error ? err.name : typeof err },
      'relay.handler_error',
    );
    // The code and detail of an AppError a stage threw, else a generic internal_error.
    closeConnection(connection, {
      code: CloseCode.InternalError,
      errorCode: isAppError(err) ? err.code : 'internal_error',
      ...(isAppError(err) && err.detail !== undefined ? { detail: err.detail } : {}),
    });
  }
}

/** What `startRelay` needs. */
export interface StartRelayOptions {
  config: RelayConfig;
  /** Interface to listen on (B004 HOST). */
  host: string;
  logger: Logger;
  metrics?: Metrics;
  /** Traces connections (B093). */
  tracer?: Tracer;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  redis: RedisBackend;
  db: RelayDb;
  /** Readiness checks (`dependencyProbe` over `redis` and `db`). */
  probe: ReadinessProbe;
  /** Default: the modules found under src/ (`discoverModules`). */
  modules?: readonly RelayModule[];
  /** Default: this build's. */
  build?: BuildInfo;
  /** Stops the startup before listening (SIGTERM during startup). */
  signal?: AbortSignal;
}

/** A started relay. */
export interface RunningRelay {
  server: RelayServer;
  port: number;
  registry: ConnectionRegistry;
  readiness: Readiness;
  /** The modules' shutdown steps, in registration order. */
  shutdownSteps: (() => Promise<void>)[];
}

/**
 * Registers the modules, takes a first readiness reading and listens. Rejects with the modules'
 * ModuleError, or the listen error (EADDRINUSE); resolves null when `signal` aborted the startup
 * (nothing listens then).
 */
export async function startRelay(options: StartRelayOptions): Promise<RunningRelay | null> {
  const metrics = options.metrics ?? noopMetrics;
  const registry = new ConnectionRegistry({
    max: options.config.maxConnections,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const readiness = new Readiness(options.probe);
  const pipeline = new FramePipeline();
  const server = new RelayServer({
    config: options.config,
    registry,
    readiness,
    pipeline,
    logger: options.logger,
    metrics,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  const shutdownSteps: (() => Promise<void>)[] = [];
  const ctx: RelayContext = {
    config: options.config,
    log: options.logger,
    metrics,
    clock: options.clock ?? Date.now,
    redis: options.redis,
    db: options.db,
    connections: registry,
    pipeline,
    onShutdown: (fn) => shutdownSteps.push(fn),
    onConnection: (handler) => server.onConnection(handler),
    addReadinessCheck: (name, check) => readiness.addCheck(name, check),
  };
  await registerModules(options.modules ?? (await discoverModules()), ctx);
  await readiness.refresh();
  if (options.signal?.aborted === true) return null;
  const port = await server.listen(options.config.port, options.host);
  readiness.start();
  const build = options.build ?? buildInfo();
  options.logger.info(
    {
      version: build.version,
      contract_version: build.contract_version,
      region: options.config.region,
      port,
      ready: readiness.ready,
    },
    'relay.started',
  );
  return { server, port, registry, readiness, shutdownSteps };
}
