/**
 * A light WebSocket client for load (B095): speaks the relay's protocol (sys.hello, welcome,
 * sequenced events, ack, pong, resume) and keeps almost nothing in memory, so thousands fit in one
 * process (the testkit's SimClient keeps up to 10 000 frames per client for assertions).
 *
 * Every frame it sends carries random bytes in `ct` (the relay and anything on the path never see
 * plaintext); the first eight bytes of `ct.c` hold the send time, so receivers measure fan-out
 * latency end to end without the relay knowing. It dedupes by seq and tracks gaps, which is the
 * "no frame loss" check.
 *
 * Owns: one connection's protocol state. Must not: send real content, or keep frames.
 */
import { randomBytes } from 'node:crypto';
import { createIdGenerator } from '@centcom/contracts';
import { PROTOCOL_DEFAULTS, SUBPROTOCOL } from '@centcom/testkit/sim';
import { WebSocket, type RawData } from 'ws';

const CT_BYTES = 48;
const ids = createIdGenerator();
const toB64 = (b: Buffer): string => b.toString('base64url');

/** Wall-clock milliseconds with sub-millisecond precision (all processes of a run share the clock). */
export const nowMs = (): number => performance.timeOrigin + performance.now();

/** What a client reports. */
export interface ClientEvents {
  /** A sequenced event from the host arrived (including the sender's own echo): latency in ms. */
  delivery(latencyMs: number): void;
  /** The connection ended (code 1006 for a network error). */
  closed(code: number, reason: string): void;
}

/** Options of one client. */
export interface LoadClientOptions {
  url: string;
  sid: string;
  /** A fresh single-use relay ticket. */
  ticket: () => Promise<string>;
  events: ClientEvents;
  /** Handshake and welcome timeout, ms. */
  timeoutMs?: number;
}

/** Why a connect failed. */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

export class LoadClient {
  private ws: WebSocket | undefined;
  private contiguous: number | null = null;
  private readonly held = new Set<number>();
  private sinceAck = 0;
  private ackedSeq = 0;
  private ackTimer: NodeJS.Timeout | undefined;
  private open_ = false;
  /** True once a welcome has been received on any connection. */
  everWelcomed = false;
  /** Distinct sequenced frames processed (each seq once). */
  delivered = 0;
  /** Frames seen again (after a resume, or replays). */
  duplicates = 0;
  /** The `resume` object of the latest welcome, for the storm report. */
  lastResume: unknown;
  /** Frames this client sent. */
  sent = 0;

  constructor(private readonly opts: LoadClientOptions) {}

  get isOpen(): boolean {
    return this.open_;
  }

  /** The highest seq processed with nothing missing before it. */
  get lastSeq(): number {
    return this.contiguous ?? 0;
  }

  /** Sequence numbers received beyond a gap and still waiting for it to fill. */
  get pendingGap(): number {
    return this.held.size;
  }

  /** Connects and resolves at `sys.welcome`. `resume` sends the last seq seen, as a reconnect does. */
  async connect(resume: boolean): Promise<void> {
    const ticket = await this.opts.ticket();
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    const ws = new WebSocket(this.opts.url, SUBPROTOCOL, {
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
    });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string, code: number): void => {
        clearTimeout(timer);
        ws.removeAllListeners('message');
        ws.terminate();
        reject(new ConnectError(message, code));
      };
      const timer = setTimeout(() => fail('no welcome', 1006), timeoutMs);
      ws.once('error', (err: Error) => fail(err.message, 1006));
      ws.once('close', (code: number) => fail(`closed ${code} before welcome`, code));
      ws.once('open', () => {
        this.send({
          v: 1,
          t: 'sys.hello',
          p: {
            protocols: [1],
            caps: ['resume'],
            ticket,
            client: { name: 'centcom-loadtest', version: '0.0.0' },
            last_seq: resume && this.contiguous !== null ? this.contiguous : null,
          },
        });
      });
      ws.on('message', (data: RawData) => {
        const text = rawText(data);
        if (text.includes('"t":"sys.welcome"')) {
          let frame: { t?: string; p?: { resume?: unknown } };
          try {
            frame = JSON.parse(text) as typeof frame;
          } catch {
            return;
          }
          if (frame.t === 'sys.welcome') {
            clearTimeout(timer);
            ws.removeAllListeners('error');
            ws.removeAllListeners('close');
            this.lastResume = frame.p?.resume;
            this.open_ = true;
            this.everWelcomed = true;
            ws.on('error', () => undefined);
            ws.on('close', (code: number, reason: Buffer) => {
              this.open_ = false;
              clearTimeout(this.ackTimer);
              this.ackTimer = undefined;
              this.opts.events.closed(code, reason.toString('utf8'));
            });
            ws.on('message', (d: RawData) => this.onMessage(rawText(d)));
            resolve();
          }
        } else if (text.includes('"t":"sys.error"')) {
          // the relay refused (at capacity, bad ticket); its close code follows
        }
      });
    });
  }

  /** Sends an encrypted-kind event with random ciphertext whose first bytes are the send time. */
  sendEvent(kind: string): void {
    if (!this.open_) return;
    const c = randomBytes(CT_BYTES);
    c.writeDoubleBE(nowMs(), 0);
    this.sent += 1;
    this.send({
      v: 1,
      t: 'event',
      id: ids('msg'),
      sid: this.opts.sid,
      k: kind,
      ct: { alg: 'xchacha20poly1305', kid: 'k1', n: toB64(randomBytes(24)), c: toB64(c) },
      sig: toB64(randomBytes(64)),
    });
  }

  /** Closes with a normal code. */
  close(): void {
    clearTimeout(this.ackTimer);
    this.ws?.close(1000);
  }

  /** Drops the socket without a close frame (a crashed client). */
  kill(): void {
    this.ws?.terminate();
  }

  private send(frame: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private onMessage(text: string): void {
    // cheap type test first: most frames are events
    if (text.startsWith('{"v":1,"t":"event"') || text.includes('"t":"event"')) {
      let frame: { seq?: number; k?: string; ct?: { c?: string } };
      try {
        frame = JSON.parse(text) as typeof frame;
      } catch {
        return;
      }
      this.onSequenced(frame.seq, frame.ct?.c);
      return;
    }
    if (text.includes('"t":"sys.ping"')) {
      let t: unknown;
      try {
        t = (JSON.parse(text) as { p?: { t?: unknown } }).p?.t;
      } catch {
        return;
      }
      this.send({ v: 1, t: 'sys.pong', p: { t } });
    }
  }

  private onSequenced(seq: number | undefined, ctC: string | undefined): void {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return;
    this.contiguous ??= seq - 1;
    if (seq <= this.contiguous || this.held.has(seq)) {
      this.duplicates += 1;
      return;
    }
    this.held.add(seq);
    while (this.held.has(this.contiguous + 1)) {
      this.held.delete(this.contiguous + 1);
      this.contiguous += 1;
      this.delivered += 1;
    }
    if (ctC !== undefined && ctC.length >= 11) {
      const stamp = Buffer.from(ctC.slice(0, 12), 'base64url').readDoubleBE(0);
      const latency = nowMs() - stamp;
      if (Number.isFinite(latency) && latency >= 0 && latency < 600_000)
        this.opts.events.delivery(latency);
    }
    this.sinceAck += 1;
    if (this.sinceAck >= PROTOCOL_DEFAULTS.ackEveryFrames) this.ack();
    else {
      this.ackTimer ??= setTimeout(() => {
        this.ackTimer = undefined;
        if ((this.contiguous ?? 0) > this.ackedSeq) this.ack();
      }, PROTOCOL_DEFAULTS.ackIntervalMs);
    }
  }

  private ack(): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.contiguous === null) return;
    this.send({ v: 1, t: 'ack', sid: this.opts.sid, ack: this.contiguous });
    this.ackedSeq = this.contiguous;
    this.sinceAck = 0;
  }
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
