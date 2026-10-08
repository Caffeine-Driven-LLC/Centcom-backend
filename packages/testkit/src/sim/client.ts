/**
 * SimClient (B011): a scripted fake client that speaks the relay protocol (CT-WS-ENVELOPE,
 * CT-RESUME) over a real WebSocket. It sends `sys.hello` as soon as the socket opens, reads the
 * welcome, answers pings, tracks the session's `seq` (in order, each frame once, out-of-order
 * frames held until the gap closes), acks after every 64 frames and within 5 s, resolves a send
 * when its echo arrives, and on `reconnect()` resumes from its highest contiguous seq and resends
 * the frames still unacked, with the same ids. Faults (faults.ts) sit between socket and protocol.
 *
 * Owns: one simulated client and its logs. Must not: set server-owned fields (except through
 * `sendFrame(..., {allowServerFields: true})`), wait without a timeout, keep more than 10 000
 * entries in a log, or reconnect by itself unless asked to (`autoReconnect`).
 */
import { CONTRACT_VERSION, createIdGenerator, isEventKind } from '@centcom/contracts';
import { WebSocket, type RawData } from 'ws';
import { systemClock, type Clock } from './clock.js';
import { applyFaults, type Fault } from './faults.js';
import {
  buildFrame,
  checkFrame,
  FrameError,
  isSequencedType,
  PROTOCOL_DEFAULTS,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  withoutServerFields,
  type Bytes,
  type Frame,
  type KindFrameType,
} from './frames.js';
import { decodeTicket, type SessionRole } from './ticket.js';

/** Every wait is bounded by this unless the call says otherwise (real time, whatever the clock). */
export const DEFAULT_TIMEOUT_MS = 5_000;
/** The most entries a log (`frames`, `wire`, `sent`) keeps; the oldest go first. */
export const MAX_LOG_ENTRIES = 10_000;
/** Close codes after which a client must not reconnect (CT-WS-ENVELOPE §Reconnection). */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([4401, 4403, 4404, 4409, 4426]);
/** What the simulator says it is in `sys.hello`. */
export const SIM_CLIENT_INFO = Object.freeze({
  name: 'centcom-sim',
  version: '1.0.0',
  contract: CONTRACT_VERSION,
});

// Waits use the real timers even when a test fakes the global ones: a hung relay must fail the test.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'sys.hello',
  'sys.welcome',
  'sys.ping',
  'sys.pong',
  'sys.error',
  'sys.slow_down',
  'sys.notice',
  'sys.resume',
  'sys.resumed',
  'sys.bye',
  'event',
  'queue',
  'control',
  'presence',
  'ack',
]);

/** How to connect. */
export interface ConnectOpts {
  /** The relay endpoint, such as `ws://127.0.0.1:<port>/v1/ws`. */
  url: string;
  /** A relay ticket, or a function returning a fresh one; tickets are single use, so reconnects call it again. */
  ticket: string | (() => string | Promise<string>);
  /** Protocol versions offered; default `[1]`. */
  protocols?: number[];
  /** Capabilities offered; default `['resume']`. */
  caps?: string[];
  /** `last_seq` of the first hello: null (default) for a fresh join, a number to resume after it. */
  lastSeq?: number | null;
  /** Protocol time (ack cadence, dead peer, faults); default the system clock. */
  clock?: Clock;
  /** Inbound faults, outermost first. */
  faults?: readonly Fault[];
  /** False opens the socket without sending `sys.hello` (to test the handshake timeout). */
  sendHello?: boolean;
  /** Validate every frame the client writes against the envelope (default true). */
  debug?: boolean;
  /** Bound of every wait, in real milliseconds; default 5000. */
  timeoutMs?: number;
  /** Reconnect after a non-terminal close, with the contract's backoff (250 ms x 2^n, full jitter, cap 15 s). */
  autoReconnect?: boolean;
  /** Uniform in [0, 1), for faults and jitter; default Math.random. */
  random?: () => number;
  /** Random bytes for opaque ciphertext; default the CSPRNG. */
  bytes?: Bytes;
  /** The `client` of `sys.hello`; default SIM_CLIENT_INFO. */
  client?: { name: string; version: string; contract?: string };
  /** Debug messages: frames ignored (unknown type or kind, unparseable), faults firing, reconnects. */
  onDebug?: (message: string, frame?: unknown) => void;
}

/** `sys.welcome`'s payload. */
export interface Welcome {
  protocol: number;
  caps?: string[];
  member: { id: string; name: string; slot: number; role: SessionRole };
  roster_v?: number;
  heartbeat: { ping_ms: number; dead_ms: number };
  server_time?: string;
  limits: Record<string, unknown>;
  resume?: Record<string, unknown> | null;
  session?: { mode?: string; state?: string };
}

/** A sequenced send, acknowledged by its echo; `seq` is 0 for frames that are not sequenced. */
export interface SendResult {
  id: string;
  seq: number;
}

/** How a connection ended. */
export interface CloseInfo {
  code: number;
  reason: string;
}

/** The connection closed (or never opened); `code` is the WebSocket close code. */
export class SimCloseError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
    /** The `sys.error` the server sent before closing, if any. */
    readonly error?: Frame,
  ) {
    const problem = typeof error?.p?.['code'] === 'string' ? `: ${error.p['code']}` : '';
    super(`the connection closed with ${code}${reason === '' ? '' : ` (${reason})`}${problem}`);
  }
}
Object.defineProperty(SimCloseError.prototype, 'name', {
  value: 'SimCloseError',
  writable: true,
  configurable: true,
});

/** A wait ran out. */
export class SimTimeoutError extends Error {}
Object.defineProperty(SimTimeoutError.prototype, 'name', {
  value: 'SimTimeoutError',
  writable: true,
  configurable: true,
});

interface Connection {
  readonly ws: WebSocket;
  readonly closed: Promise<CloseInfo>;
  /** False once it closed or was cut: whatever it still delivers is ignored. */
  live: boolean;
}

interface Outbound {
  frame: Frame & { id: string };
  settle(result: SendResult): void;
  fail(err: Error): void;
}

interface Waiter {
  pred: (frame: Frame) => boolean;
  resolve(frame: Frame): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rawText = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.from(data as ArrayBuffer).toString('utf8');

/** A simulated client. Create it with `SimClient.connect()`. */
export class SimClient {
  private readonly opts: ConnectOpts;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly debug: boolean;
  private readonly random: () => number;
  private readonly ids = createIdGenerator();
  private readonly log: Frame[] = [];
  private readonly wireLog: Frame[] = [];
  private readonly sentLog: Frame[] = [];
  private readonly held = new Map<number, Frame>();
  private readonly outbound = new Map<string, Outbound>();
  private readonly waiters = new Set<Waiter>();
  private conn: Connection | undefined;
  private sessionId = '';
  private welcomeValue: Welcome | undefined;
  private closeValue: CloseInfo | undefined;
  private lastErrorFrame: Frame | undefined;
  private socketError: Error | undefined;
  /** Highest seq processed with no gap before it; null until the first sequenced frame of a fresh join. */
  private contiguous: number | null;
  private ackedSeq = 0;
  private sinceAck = 0;
  private ackTimer: unknown;
  private deadTimer: unknown;
  private reconnectTimer: unknown;
  private closing = false;
  private welcomed = false;
  private attempts = 0;
  private protocolCloses: number[] = [];

  private constructor(opts: ConnectOpts) {
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.debug = opts.debug ?? true;
    this.random = opts.random ?? Math.random;
    this.contiguous = opts.lastSeq ?? null;
  }

  /** Opens a connection and completes the handshake (unless `sendHello: false`). */
  static async connect(opts: ConnectOpts): Promise<SimClient> {
    const client = new SimClient(opts);
    await client.open(opts.lastSeq ?? null);
    return client;
  }

  /** Frames processed, in order: sequenced frames once each and in seq order, and every other frame received. */
  get frames(): readonly Frame[] {
    return this.log;
  }

  /** Every frame that reached the protocol layer (after faults), duplicates and out-of-order frames included. */
  get wire(): readonly Frame[] {
    return this.wireLog;
  }

  /** Every frame this client wrote, in order (raw `sendRaw` text excluded). */
  get sent(): readonly Frame[] {
    return this.sentLog;
  }

  /** The highest seq processed with no gap before it (0 before any). */
  get lastSeq(): number {
    return this.contiguous ?? 0;
  }

  /** The current connection's welcome; undefined until the handshake completes. */
  get welcome(): Welcome | undefined {
    return this.welcomeValue;
  }

  /** This client's member id (from the welcome). */
  get memberId(): string | undefined {
    return this.welcomeValue?.member.id;
  }

  /** The session (from the ticket). */
  get sid(): string {
    return this.sessionId;
  }

  /** How the latest connection ended; undefined while it is open. */
  get closeInfo(): CloseInfo | undefined {
    return this.closeValue;
  }

  /** Ids of own sequenced frames not yet echoed; they are resent after a reconnect. */
  get unackedIds(): string[] {
    return [...this.outbound.keys()];
  }

  /** True while the connection is open. */
  get isOpen(): boolean {
    return this.conn?.live === true && this.conn.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sends a frame of `kind`: a fresh `msg_` id, the kind's frame type, `p` when given, and opaque
   * ciphertext plus a dummy signature when the kind is encrypted or hybrid (or `ct: true`).
   * Sequenced frames resolve with their `seq` when the echo arrives; others resolve at once with 0.
   */
  send(
    kind: string,
    p?: Record<string, unknown>,
    opts: { ct?: boolean; type?: KindFrameType } = {},
  ): Promise<SendResult> {
    let frame: Frame;
    try {
      frame = buildFrame(kind, p, {
        sid: this.sessionId,
        id: this.ids('msg'),
        ...(opts.type === undefined ? {} : { type: opts.type }),
        ...(opts.ct === undefined ? {} : { ct: opts.ct }),
        ...(this.opts.bytes === undefined ? {} : { bytes: this.opts.bytes }),
      });
    } catch (err) {
      return Promise.reject(err as Error);
    }
    return this.sendFrame(frame);
  }

  /**
   * Sends a client frame as given, without `from`, `ts` and `seq` unless `allowServerFields` (a
   * fault scenario asserting the server ignores them). Sequenced frames need an `id`.
   */
  sendFrame(frame: Frame, opts: { allowServerFields?: boolean } = {}): Promise<SendResult> {
    const out = opts.allowServerFields === true ? { ...frame } : withoutServerFields(frame);
    try {
      if (this.debug) checkFrame(out);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    if (!isSequencedType(out.t)) {
      this.write(out, false);
      return Promise.resolve({ id: out.id ?? '', seq: 0 });
    }
    const id = out.id;
    if (id === undefined) return Promise.reject(new FrameError(`a ${out.t} frame needs an id`));
    if (this.outbound.has(id))
      return Promise.reject(new FrameError(`${id} is already waiting for its echo`));
    const result = new Promise<SendResult>((resolve, reject) => {
      const timer = realSetTimeout(() => {
        // The frame stays unacked (it is resent after a reconnect); only this wait gives up.
        reject(new SimTimeoutError(`no echo of ${id} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      timer.unref();
      this.outbound.set(id, {
        frame: { ...out, id },
        settle: (value) => {
          realClearTimeout(timer);
          resolve(value);
        },
        fail: (err) => {
          realClearTimeout(timer);
          reject(err);
        },
      });
    });
    // A test may fire and forget; a rejection then is not an unhandled one. Awaiting still throws.
    result.catch(() => undefined);
    this.write(out, false);
    return result;
  }

  /** Writes `data` to the socket exactly as given (malformed JSON, oversize frames, ...). */
  sendRaw(data: string): void {
    const conn = this.conn;
    if (conn === undefined || !this.isOpen) throw new Error('sendRaw: the client is not connected');
    conn.ws.send(data);
  }

  /** Sends `ack` with the highest contiguous seq now (it also goes out after 64 frames and within 5 s). */
  ack(): void {
    this.sendAck();
  }

  /** The first processed frame matching `pred`, already received or arriving within `timeoutMs`. */
  waitFor(pred: (frame: Frame) => boolean, timeoutMs = this.timeoutMs): Promise<Frame> {
    const seen = this.log.find((frame) => matches(pred, frame));
    return seen === undefined ? this.waitForNext(pred, timeoutMs) : Promise.resolve(seen);
  }

  /** The next processed frame matching `pred`, arriving within `timeoutMs`. */
  waitForNext(pred: (frame: Frame) => boolean, timeoutMs = this.timeoutMs): Promise<Frame> {
    const { promise, cancel } = this.watch(pred);
    return bounded(promise, `no matching frame within ${timeoutMs} ms`, timeoutMs, cancel);
  }

  /** Resolves when the current connection closes (at once if it already has). */
  waitForClose(timeoutMs = this.timeoutMs): Promise<CloseInfo> {
    const conn = this.conn;
    if (conn === undefined)
      return Promise.reject(new Error('waitForClose: the client never connected'));
    return bounded(conn.closed, `the connection did not close within ${timeoutMs} ms`, timeoutMs);
  }

  /** Stops reading the socket (a stalled client): nothing is processed or answered until `unstall()`. */
  stall(): void {
    this.conn?.ws.pause();
  }

  /** Reads the socket again after `stall()`. */
  unstall(): void {
    this.conn?.ws.resume();
  }

  /** Drops the connection without a close frame, as a network failure would (the server sees 1006). */
  terminate(): void {
    if (this.conn !== undefined) this.cut(this.conn, 1006);
  }

  /** Closes the connection with `code` (default 1000) and stops any reconnecting. Pending sends fail. */
  async close(code = 1000): Promise<void> {
    this.closing = true;
    this.clearTimers();
    const conn = this.conn;
    if (conn !== undefined && conn.ws.readyState !== WebSocket.CLOSED) {
      conn.live = false;
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.close(code);
      else conn.ws.terminate();
      try {
        await bounded(conn.closed, 'close handshake', this.timeoutMs);
      } catch {
        conn.ws.terminate();
        await conn.closed;
      }
    }
    for (const out of this.outbound.values())
      out.fail(new SimCloseError(code, 'closed by the test'));
    this.outbound.clear();
  }

  /**
   * Opens a new connection (dropping the current one if it is still up), sends `sys.hello` with
   * `last_seq` = the highest contiguous seq processed, and after the welcome resends every unacked
   * frame with its original id. Uses `ticket` or the `ticket` function of the connect options.
   */
  async reconnect(opts: { ticket?: string } = {}): Promise<void> {
    this.closing = false;
    this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const old = this.conn;
    if (old !== undefined && old.ws.readyState !== WebSocket.CLOSED) {
      this.cut(old, 1006);
      await old.closed;
    }
    await this.open(this.contiguous, opts.ticket);
  }

  private async open(lastSeq: number | null, ticketOverride?: string): Promise<void> {
    const ticket =
      ticketOverride ??
      (typeof this.opts.ticket === 'function' ? await this.opts.ticket() : this.opts.ticket);
    const sid = decodeTicket(ticket).sid;
    if (typeof sid === 'string') this.sessionId = sid;
    const ws = new WebSocket(this.opts.url, SUBPROTOCOL, {
      handshakeTimeout: this.timeoutMs,
      perMessageDeflate: false,
    });
    const conn: Connection = {
      ws,
      live: true,
      closed: new Promise<CloseInfo>((resolve) => {
        ws.once('close', (code: number, reason: Buffer) =>
          resolve({ code, reason: reason.toString('utf8') }),
        );
      }),
    };
    this.conn = conn;
    this.closeValue = undefined;
    this.welcomeValue = undefined;
    ws.on('error', (err: Error) => {
      this.socketError = err;
    });
    void conn.closed.then((info) => this.onClose(conn, info));
    const deliver = applyFaults(
      this.opts.faults ?? [],
      (data) => {
        if (this.conn === conn && conn.live) this.onMessage(data);
      },
      { clock: this.clock, random: this.random, disconnect: (code) => this.cut(conn, code) },
    );
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) this.onDebug('a binary frame was ignored (binary frames are reserved)');
      else deliver(rawText(data));
    });

    await bounded(
      new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        void conn.closed.then((info) =>
          reject(
            new SimCloseError(
              info.code,
              info.reason === '' ? (this.socketError?.message ?? '') : info.reason,
            ),
          ),
        );
      }),
      'the WebSocket did not open',
      this.timeoutMs,
      () => ws.terminate(),
    );
    if (this.opts.sendHello === false) return;

    const welcome = this.watch((frame) => frame.t === 'sys.welcome');
    this.write(
      {
        v: PROTOCOL_VERSION,
        t: 'sys.hello',
        p: {
          protocols: this.opts.protocols ?? [PROTOCOL_VERSION],
          caps: this.opts.caps ?? ['resume'],
          ticket,
          client: this.opts.client ?? { ...SIM_CLIENT_INFO },
          last_seq: lastSeq,
        },
      },
      this.debug,
    );
    const outcome = await bounded(
      Promise.race([
        welcome.promise.then((frame) => ({ frame, info: undefined })),
        conn.closed.then((info) => ({ frame: undefined, info })),
      ]),
      'no sys.welcome',
      this.timeoutMs,
      () => {
        welcome.cancel();
        this.cut(conn, 1006);
      },
    );
    if (outcome.frame === undefined) {
      welcome.cancel();
      const info = outcome.info ?? { code: 1006, reason: '' };
      throw new SimCloseError(info.code, info.reason, this.lastErrorFrame);
    }
    this.welcomed = true;
    this.attempts = 0;
    this.touch();
  }

  /**
   * Handled as the welcome is read, not when open() resumes: the replay can arrive in the same
   * read, and its echoes are matched to this member. The unacked frames are resent first
   * (CT-WS-ENVELOPE §Reconnection step 4), so a replayed echo never stands in for the resend.
   */
  private onWelcome(frame: Frame): void {
    this.welcomeValue = frame.p as unknown as Welcome;
    for (const out of this.outbound.values()) this.write(out.frame, false);
  }

  private onMessage(data: string): void {
    this.touch();
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.onDebug('a frame that is not JSON was ignored');
      return;
    }
    if (!isRecord(parsed)) {
      this.onDebug('a frame that is not a JSON object was ignored', parsed);
      return;
    }
    const frame = parsed as unknown as Frame;
    record(this.wireLog, frame);
    if (isSequencedType(frame.t)) {
      this.onSequenced(frame);
      return;
    }
    if (!KNOWN_TYPES.has(frame.t)) {
      this.onDebug(`a frame of unknown type ${JSON.stringify(frame.t)} was ignored`, frame);
      return;
    }
    if (frame.t === 'sys.ping')
      this.write({ v: PROTOCOL_VERSION, t: 'sys.pong', p: { t: frame.p?.['t'] } }, this.debug);
    if (frame.t === 'sys.error') this.lastErrorFrame = frame;
    if (frame.t === 'sys.welcome') this.onWelcome(frame);
    this.deliver(frame);
  }

  private onSequenced(frame: Frame): void {
    const seq = frame.seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
      this.onDebug('a sequenced frame without a valid seq was ignored', frame);
      return;
    }
    // A fresh join learns where the session is from the first frame it gets.
    this.contiguous ??= seq - 1;
    if (seq <= this.contiguous || this.held.has(seq)) return; // a duplicate
    if (this.held.size >= MAX_LOG_ENTRIES) {
      this.onDebug(
        `seq ${seq} was dropped: ${MAX_LOG_ENTRIES} frames already wait behind a gap`,
        frame,
      );
      return;
    }
    this.held.set(seq, frame);
    for (
      let next = this.held.get(this.contiguous + 1);
      next !== undefined;
      next = this.held.get(this.contiguous + 1)
    ) {
      this.held.delete(this.contiguous + 1);
      this.contiguous += 1;
      this.process(next);
    }
  }

  private process(frame: Frame): void {
    if (frame.k !== undefined && !isEventKind(frame.k))
      this.onDebug(`a frame of unknown kind ${frame.k}`, frame);
    const own = frame.id === undefined ? undefined : this.outbound.get(frame.id);
    if (
      own !== undefined &&
      frame.id !== undefined &&
      (frame.from === undefined || frame.from === this.memberId)
    ) {
      this.outbound.delete(frame.id);
      own.settle({ id: frame.id, seq: frame.seq ?? 0 });
    }
    this.deliver(frame);
    this.sinceAck += 1;
    if (this.sinceAck >= PROTOCOL_DEFAULTS.ackEveryFrames) this.sendAck();
    else
      this.ackTimer ??= this.clock.setTimeout(() => {
        this.ackTimer = undefined;
        if ((this.contiguous ?? 0) > this.ackedSeq) this.sendAck();
      }, PROTOCOL_DEFAULTS.ackIntervalMs);
  }

  private deliver(frame: Frame): void {
    record(this.log, frame);
    for (const waiter of this.waiters) {
      if (matches(waiter.pred, frame)) {
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  }

  private sendAck(): void {
    this.clock.clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.contiguous === null || !this.isOpen) return;
    this.write(
      { v: PROTOCOL_VERSION, t: 'ack', sid: this.sessionId, ack: this.contiguous },
      this.debug,
    );
    this.ackedSeq = this.contiguous;
    this.sinceAck = 0;
  }

  /** Any inbound frame proves the peer alive; silence for dead_ms drops the connection. */
  private touch(): void {
    const conn = this.conn;
    if (conn === undefined) return;
    this.clock.clearTimeout(this.deadTimer);
    const deadMs = this.welcomeValue?.heartbeat.dead_ms ?? PROTOCOL_DEFAULTS.deadMs;
    this.deadTimer = this.clock.setTimeout(() => {
      if (this.conn !== conn || !conn.live) return;
      this.onDebug(`nothing received for ${deadMs} ms: dropping the connection`);
      this.cut(conn, 1006);
    }, deadMs);
  }

  private write(frame: Frame, validate: boolean): void {
    if (validate) checkFrame(frame);
    record(this.sentLog, frame);
    const conn = this.conn;
    if (conn?.live === true && conn.ws.readyState === WebSocket.OPEN)
      conn.ws.send(JSON.stringify(frame));
  }

  private cut(conn: Connection, code: number): void {
    if (!conn.live && conn.ws.readyState === WebSocket.CLOSED) return;
    conn.live = false;
    if (code === 1006 || conn.ws.readyState !== WebSocket.OPEN) conn.ws.terminate();
    else conn.ws.close(code);
  }

  private onClose(conn: Connection, info: CloseInfo): void {
    conn.live = false;
    if (this.conn !== conn) return;
    this.clearTimers();
    this.closeValue = info;
    if (
      this.opts.autoReconnect === true &&
      this.welcomed &&
      !this.closing &&
      this.mayReconnect(info.code)
    ) {
      const delay = this.random() * Math.min(15_000, 250 * 2 ** this.attempts);
      this.attempts += 1;
      this.onDebug(`closed with ${info.code}; reconnecting in ${Math.round(delay)} ms`);
      this.reconnectTimer = this.clock.setTimeout(() => {
        this.reconnectTimer = undefined;
        this.reconnect().catch((err: unknown) =>
          this.onDebug(`reconnect failed: ${(err as Error).message}`),
        );
      }, delay);
    }
  }

  /** CT-WS-ENVELOPE §Reconnection: never after 4401/4403/4404/4409/4426, nor after three 4400s in 60 s. */
  private mayReconnect(code: number): boolean {
    if (TERMINAL_CLOSE_CODES.has(code)) return false;
    if (code !== 4400) return true;
    const now = this.clock.now();
    this.protocolCloses = [...this.protocolCloses.filter((at) => now - at < 60_000), now];
    return this.protocolCloses.length < 3;
  }

  private clearTimers(): void {
    for (const timer of [this.ackTimer, this.deadTimer, this.reconnectTimer])
      this.clock.clearTimeout(timer);
    this.ackTimer = undefined;
    this.deadTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private watch(pred: (frame: Frame) => boolean): { promise: Promise<Frame>; cancel: () => void } {
    const waiter: Waiter = { pred, resolve: () => undefined };
    const promise = new Promise<Frame>((resolve) => {
      waiter.resolve = resolve;
    });
    this.waiters.add(waiter);
    return { promise, cancel: () => this.waiters.delete(waiter) };
  }

  private onDebug(message: string, frame?: unknown): void {
    this.opts.onDebug?.(message, frame);
  }
}

/** A predicate that throws does not match. */
function matches(pred: (frame: Frame) => boolean, frame: Frame): boolean {
  try {
    return pred(frame);
  } catch {
    return false;
  }
}

function record(log: Frame[], frame: Frame): void {
  log.push(frame);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
}

/** `promise`, or a SimTimeoutError after `ms` real milliseconds (calling `onTimeout` first). */
function bounded<T>(
  promise: Promise<T>,
  what: string,
  ms: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = realSetTimeout(() => {
      onTimeout?.();
      reject(new SimTimeoutError(what));
    }, ms);
    promise.then(
      (value) => {
        realClearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        realClearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}
