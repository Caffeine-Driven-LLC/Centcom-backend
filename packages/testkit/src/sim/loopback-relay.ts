/**
 * LoopbackRelay (B011): a small in-process relay that exists to test the simulator itself. It
 * implements the parts of CT-WS-ENVELOPE and CT-RESUME a client meets: `sys.hello` within 5 s
 * (else close 4408), the ticket check against the test JWKS with single-use `jti` (else
 * `sys.error` and 4401), protocol negotiation (4426), the welcome, pings every `ping_ms` and
 * dropping a peer silent for `dead_ms`, schema validation of every frame (`sys.error`
 * invalid_frame; more than 10 in a minute closes 4400), the 256 KiB limit, session-wide `seq`
 * assigned in arrival order and echoed to the sender, de-duplication by (sid, from, id), replay
 * after `last_seq` with `sys.resumed`, and superseding a second connection of a member's device.
 *
 * Owns: nothing outside tests. It is not the relay (B037 on): no authorization by role, no rate
 * limits, no durable history. Exported only from `@centcom/testkit/sim`, never the package root.
 */
import type { AddressInfo } from 'node:net';
import { createIdGenerator, ERRORS, validateEnvelope, type ErrorCode } from '@centcom/contracts';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { systemClock, type Clock } from './clock.js';
import {
  describeIssues,
  frameBytes,
  MAX_FRAME_BYTES,
  PROTOCOL_DEFAULTS,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  type Frame,
} from './frames.js';
import { testJwks, verifyTestTicket, type JsonWebKeySet, type TicketClaims } from './ticket.js';

/** Settings; the defaults are the contract's. */
export interface LoopbackRelayOptions {
  clock?: Clock;
  /** Keys tickets must be signed with; default `testJwks()`. */
  jwks?: JsonWebKeySet;
  pingMs?: number;
  deadMs?: number;
  helloTimeoutMs?: number;
  maxFrameBytes?: number;
  /** More invalid frames than this within `invalidWindowMs` close the connection with 4400. */
  invalidLimit?: number;
  invalidWindowMs?: number;
  /** Sequenced frames kept per session for replay. */
  replayFrames?: number;
  /** What `welcome.session` says. */
  session?: {
    mode: 'command_post' | 'branch';
    state: 'pending' | 'live' | 'paused' | 'ended' | 'expired';
  };
}

interface Session {
  readonly sid: string;
  seq: number;
  rosterVersion: number;
  /** The last `replayFrames` sequenced frames, oldest first. */
  readonly log: Frame[];
  /** `${from}|${id}` of every sequenced frame accepted. */
  readonly seen: Set<string>;
  readonly slots: Map<string, number>;
  readonly connections: Set<Peer>;
}

interface Peer {
  readonly ws: WebSocket;
  claims?: TicketClaims;
  session?: Session;
  helloTimer: unknown;
  pingTimer: unknown;
  deadTimer: unknown;
  /** Times of recent invalid frames. */
  invalid: number[];
  /** The peer's latest `ack`. */
  acked: number;
}

/** Most frames kept in `received`. */
const MAX_RECEIVED = 10_000;

/** A relay for the simulator's own tests. Start it with `LoopbackRelay.start()`. */
export class LoopbackRelay {
  /** `ws://127.0.0.1:<port>/v1/ws`. */
  readonly url: string;
  /** Every valid frame clients sent, in arrival order (capped at 10 000). */
  readonly received: Frame[] = [];
  /** Sequenced frames dropped as duplicates of an accepted (sid, from, id). */
  duplicates = 0;
  private readonly server: WebSocketServer;
  private readonly clock: Clock;
  private readonly jwks: JsonWebKeySet;
  private readonly settings: Required<Omit<LoopbackRelayOptions, 'clock' | 'jwks'>>;
  private readonly sessions = new Map<string, Session>();
  private readonly peers = new Set<Peer>();
  private readonly usedJtis = new Set<string>();
  private readonly requestIds = createIdGenerator();
  private readonly waiters = new Set<{
    pred: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }>();

  private constructor(server: WebSocketServer, opts: LoopbackRelayOptions) {
    const { port } = server.address() as AddressInfo;
    this.url = `ws://127.0.0.1:${port}/v1/ws`;
    this.server = server;
    this.clock = opts.clock ?? systemClock;
    this.jwks = opts.jwks ?? testJwks();
    this.settings = {
      pingMs: opts.pingMs ?? PROTOCOL_DEFAULTS.pingMs,
      deadMs: opts.deadMs ?? PROTOCOL_DEFAULTS.deadMs,
      helloTimeoutMs: opts.helloTimeoutMs ?? PROTOCOL_DEFAULTS.helloTimeoutMs,
      maxFrameBytes: opts.maxFrameBytes ?? MAX_FRAME_BYTES,
      invalidLimit: opts.invalidLimit ?? 10,
      invalidWindowMs: opts.invalidWindowMs ?? 60_000,
      replayFrames: opts.replayFrames ?? 5_000,
      session: opts.session ?? { mode: 'command_post', state: 'live' },
    };
    server.on('connection', (ws) => this.onConnection(ws));
  }

  /** Listens on a free port of 127.0.0.1. */
  static async start(opts: LoopbackRelayOptions = {}): Promise<LoopbackRelay> {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: '/v1/ws',
      // Larger than the frame limit, so an oversize frame gets a sys.error rather than ws's 1009.
      maxPayload: 4 * (opts.maxFrameBytes ?? MAX_FRAME_BYTES),
      perMessageDeflate: false,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    return new LoopbackRelay(server, opts);
  }

  /** The sequenced frames of a session still in its replay buffer, oldest first. */
  log(sid: string): readonly Frame[] {
    return this.sessions.get(sid)?.log ?? [];
  }

  /** Open connections. */
  get connections(): number {
    return this.peers.size;
  }

  /** The first received frame matching `pred`, already in `received` or arriving within `timeoutMs`. */
  waitFor(pred: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
    const seen = this.received.find(pred);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise<Frame>((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (frame: Frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`LoopbackRelay: no matching frame within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** Drops every connection and stops listening. */
  async close(): Promise<void> {
    for (const peer of this.peers) {
      this.clearTimers(peer);
      peer.ws.terminate();
    }
    this.peers.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(ws: WebSocket): void {
    const peer: Peer = {
      ws,
      helloTimer: undefined,
      pingTimer: undefined,
      deadTimer: undefined,
      invalid: [],
      acked: 0,
    };
    this.peers.add(peer);
    peer.helloTimer = this.clock.setTimeout(() => {
      if (peer.claims === undefined) ws.close(4408, 'no sys.hello within the handshake window');
    }, this.settings.helloTimeoutMs);
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(peer, data, isBinary));
    ws.on('close', () => this.onClose(peer));
    ws.on('error', () => undefined);
  }

  private onMessage(peer: Peer, data: RawData, isBinary: boolean): void {
    this.touch(peer);
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data as Buffer).toString('utf8');
    if (isBinary) return this.invalid(peer, 'binary frames are reserved');
    const size = frameBytes(text);
    if (size > this.settings.maxFrameBytes) {
      return this.invalid(
        peer,
        `the frame is ${size} bytes; the limit is ${this.settings.maxFrameBytes}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.invalid(peer, 'the frame is not JSON');
    }
    const result = validateEnvelope(parsed);
    if (!result.ok) return this.invalid(peer, describeIssues(result.errors));
    const frame = result.value;
    this.record(frame);

    if (peer.claims === undefined) {
      if (frame.t !== 'sys.hello')
        return this.refuse(peer, 'protocol_violation', 'sys.hello must come first', 4400);
      return this.onHello(peer, frame);
    }
    switch (frame.t) {
      case 'event':
      case 'queue':
      case 'control':
        return this.onSequenced(peer, frame);
      case 'presence':
        return this.broadcast(peer, { ...frame, from: peer.claims.mid, ts: this.isoNow() }, false);
      case 'ack':
        peer.acked = Math.max(peer.acked, frame.ack ?? 0);
        return;
      case 'sys.ping':
        return this.send(peer, { v: PROTOCOL_VERSION, t: 'sys.pong', p: { t: frame.p?.['t'] } });
      case 'sys.pong':
        return;
      case 'sys.resume': {
        const lastSeq = frame.p?.['last_seq'];
        if (typeof lastSeq !== 'number') return this.invalid(peer, 'sys.resume needs p.last_seq');
        return this.replay(peer, lastSeq);
      }
      case 'sys.bye':
        peer.ws.close(1000, 'bye');
        return;
      default:
        return this.invalid(peer, `clients do not send ${frame.t}`);
    }
  }

  private onHello(peer: Peer, frame: Frame): void {
    const hello = frame.p ?? {};
    const protocols = hello['protocols'];
    if (!Array.isArray(protocols) || !protocols.includes(PROTOCOL_VERSION)) {
      return this.refuse(
        peer,
        'unsupported_protocol',
        `this relay speaks protocol ${PROTOCOL_VERSION}`,
        4426,
      );
    }
    const check = verifyTestTicket(String(hello['ticket']), {
      jwks: this.jwks,
      now: this.clock.now(),
    });
    if (!check.ok)
      return this.refuse(
        peer,
        'ticket_invalid',
        `ticket ${check.problem.replace(/_/g, ' ')}`,
        4401,
      );
    const claims = check.claims;
    if (this.usedJtis.has(claims.jti))
      return this.refuse(peer, 'ticket_replayed', 'the ticket was already used', 4401);
    this.usedJtis.add(claims.jti);
    this.clock.clearTimeout(peer.helloTimer);
    peer.claims = claims;

    const session = this.sessionFor(claims.sid);
    for (const other of session.connections) {
      if (other.claims?.mid === claims.mid && other.claims.dev === claims.dev) {
        this.send(other, { v: PROTOCOL_VERSION, t: 'sys.bye', p: { reason: 'superseded' } });
        other.ws.close(4409, 'superseded');
        session.connections.delete(other);
      }
    }
    if (!session.slots.has(claims.mid)) {
      session.slots.set(claims.mid, session.slots.size);
      session.rosterVersion += 1;
    }
    session.connections.add(peer);
    peer.session = session;

    const lastSeq = hello['last_seq'];
    const slot = session.slots.get(claims.mid) ?? 0;
    this.send(peer, {
      v: PROTOCOL_VERSION,
      t: 'sys.welcome',
      p: {
        protocol: PROTOCOL_VERSION,
        caps: Array.isArray(hello['caps']) ? hello['caps'].filter((cap) => cap === 'resume') : [],
        member: { id: claims.mid, name: `Member ${slot + 1}`, slot, role: claims.role },
        roster_v: session.rosterVersion,
        heartbeat: { ping_ms: this.settings.pingMs, dead_ms: this.settings.deadMs },
        server_time: this.isoNow(),
        limits: { max_frame_bytes: this.settings.maxFrameBytes, max_members: 50 },
        resume: typeof lastSeq === 'number' ? { from_seq: lastSeq + 1 } : null,
        session: { ...this.settings.session },
      },
    });
    if (typeof lastSeq === 'number') this.replay(peer, lastSeq);
    this.schedulePing(peer);
  }

  private onSequenced(peer: Peer, frame: Frame): void {
    const session = peer.session;
    const member = peer.claims?.mid;
    if (session === undefined || member === undefined) return;
    if (frame.sid !== session.sid)
      return this.invalid(peer, `the frame is for ${String(frame.sid)}, not ${session.sid}`);
    const key = `${member}|${String(frame.id)}`;
    if (session.seen.has(key)) {
      this.duplicates += 1;
      return;
    }
    session.seen.add(key);
    session.seq += 1;
    // Client-supplied from/ts/seq are ignored; `ack` is the sender's own business.
    const stamped: Frame = { ...frame, from: member, ts: this.isoNow(), seq: session.seq };
    delete stamped.ack;
    session.log.push(stamped);
    if (session.log.length > this.settings.replayFrames) session.log.shift();
    this.broadcast(peer, stamped, true);
  }

  private replay(peer: Peer, lastSeq: number): void {
    const session = peer.session;
    if (session === undefined) return;
    const frames = session.log.filter((frame) => (frame.seq ?? 0) > lastSeq);
    for (const frame of frames) this.send(peer, frame);
    const earliest = session.log[0]?.seq;
    this.send(peer, {
      v: PROTOCOL_VERSION,
      t: 'sys.resumed',
      p: {
        from_seq: frames[0]?.seq ?? lastSeq + 1,
        to_seq: frames.at(-1)?.seq ?? lastSeq,
        count: frames.length,
        ...(earliest !== undefined && earliest > lastSeq + 1 ? { history_gap: true } : {}),
      },
    });
  }

  private broadcast(from: Peer, frame: Frame, toSender: boolean): void {
    for (const peer of from.session?.connections ?? []) {
      if (toSender || peer !== from) this.send(peer, frame);
    }
  }

  /** `sys.error` invalid_frame; the frame after `invalidLimit` in a window also closes with 4400. */
  private invalid(peer: Peer, detail: string): void {
    const now = this.clock.now();
    peer.invalid = [...peer.invalid.filter((at) => now - at < this.settings.invalidWindowMs), now];
    if (peer.invalid.length > this.settings.invalidLimit) {
      return this.refuse(
        peer,
        'invalid_frame',
        `${detail} (more than ${this.settings.invalidLimit} invalid frames)`,
        4400,
      );
    }
    this.send(peer, this.problem('invalid_frame', detail));
  }

  /** `sys.error`, then close with `closeCode`. */
  private refuse(peer: Peer, code: ErrorCode, detail: string, closeCode: number): void {
    this.send(peer, this.problem(code, detail));
    peer.ws.close(closeCode, code);
  }

  private problem(code: ErrorCode, detail: string): Frame {
    const entry = ERRORS[code];
    return {
      v: PROTOCOL_VERSION,
      t: 'sys.error',
      p: {
        type: entry.type,
        title: entry.title,
        status: entry.status,
        code,
        detail,
        request_id: this.requestIds('req'),
      },
    };
  }

  private schedulePing(peer: Peer): void {
    peer.pingTimer = this.clock.setTimeout(() => {
      this.send(peer, { v: PROTOCOL_VERSION, t: 'sys.ping', p: { t: this.clock.now() } });
      this.schedulePing(peer);
    }, this.settings.pingMs);
  }

  private touch(peer: Peer): void {
    this.clock.clearTimeout(peer.deadTimer);
    peer.deadTimer = this.clock.setTimeout(() => peer.ws.terminate(), this.settings.deadMs);
  }

  private send(peer: Peer, frame: Frame): void {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(frame));
  }

  private record(frame: Frame): void {
    this.received.push(frame);
    if (this.received.length > MAX_RECEIVED) this.received.shift();
    for (const waiter of this.waiters) {
      if (waiter.pred(frame)) {
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  }

  private sessionFor(sid: string): Session {
    let session = this.sessions.get(sid);
    if (session === undefined) {
      session = {
        sid,
        seq: 0,
        rosterVersion: 0,
        log: [],
        seen: new Set(),
        slots: new Map(),
        connections: new Set(),
      };
      this.sessions.set(sid, session);
    }
    return session;
  }

  private onClose(peer: Peer): void {
    this.clearTimers(peer);
    this.peers.delete(peer);
    peer.session?.connections.delete(peer);
  }

  private clearTimers(peer: Peer): void {
    this.clock.clearTimeout(peer.helloTimer);
    this.clock.clearTimeout(peer.pingTimer);
    this.clock.clearTimeout(peer.deadTimer);
  }

  private isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
