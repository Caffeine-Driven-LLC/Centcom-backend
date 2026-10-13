/**
 * The clients of one generator process (B095): sessions of synthetic members, the sender that makes
 * each session's host emit events at a steady rate, the delivery and close counters, and the
 * reconnect behaviour of the storm profile. Runs inside a worker process (worker.ts); the
 * coordinator (relay-load.ts) merges the workers' counters.
 */
import { mintTestTicket } from '@centcom/testkit/sim';
import { ConnectError, LoadClient } from './client.js';
import { Histogram } from './hist.js';
import { Seeder } from './seed.js';

export interface Member {
  client: LoadClient;
  sid: string;
  lostAt?: number;
  resumedAt?: number;
  attempts: number;
}
export interface Session {
  sid: string;
  members: Member[];
  credit: number;
}

export class Population {
  readonly sessions: Session[] = [];
  readonly latency = new Histogram();
  unexpectedCloses = 0;
  connectFailures = 0;
  /** Handshakes retried after a 4503. */
  retries = 0;
  readonly connectErrors = new Map<string, number>();
  stormMode = false;
  private closing = false;
  private timer: NodeJS.Timeout | undefined;
  private tick = performance.now();
  private fps = 0;

  constructor(
    private readonly urls: readonly string[],
    private readonly membersPerSession: number,
    private readonly seeder: Seeder,
  ) {}

  get connections(): number {
    let n = 0;
    for (const s of this.sessions) for (const m of s.members) if (m.client.isOpen) n += 1;
    return n;
  }

  /** Adds `count` connections, in whole sessions, `concurrency` handshakes at a time. */
  async grow(count: number, concurrency = 40): Promise<void> {
    const sessionCount = Math.ceil(count / this.membersPerSession);
    const seeded = await this.seeder.sessions(
      sessionCount,
      this.membersPerSession,
      this.sessions.length,
    );
    const queue: (() => Promise<void>)[] = [];
    for (const seed of seeded) {
      const { sid } = seed;
      const session: Session = { sid, members: [], credit: Math.random() };
      this.sessions.push(session);
      seed.members.forEach((who, m) => {
        const member: Member = { sid, attempts: 0, client: undefined as unknown as LoadClient };
        member.client = new LoadClient({
          url: this.urls[m % this.urls.length] ?? '',
          sid,
          ticket: () => mintTestTicket({ sid, mid: who.mid, role: who.role, dev: who.dev }),
          events: {
            delivery: (ms) => this.latency.add(ms),
            closed: () => this.onClosed(member),
          },
        });
        session.members.push(member);
        queue.push(async () => {
          // like a real client: a refusal for overload (4503) is retried after a short random wait
          for (let attempt = 1; ; attempt += 1) {
            try {
              await member.client.connect(false);
              return;
            } catch (err) {
              const overloaded = err instanceof ConnectError && err.code === 4503;
              if (overloaded && attempt < 8) {
                this.retries += 1;
                await new Promise((r) => setTimeout(r, 500 + Math.random() * 2000 * attempt));
                continue;
              }
              this.connectFailures += 1;
              const text = err instanceof Error ? err.message : String(err);
              this.connectErrors.set(text, (this.connectErrors.get(text) ?? 0) + 1);
              if (!(err instanceof ConnectError)) throw err;
              return;
            }
          }
        });
      });
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let job = queue[next++]; job !== undefined; job = queue[next++]) await job();
      }),
    );
  }

  private onClosed(member: Member): void {
    if (this.closing) return;
    this.unexpectedCloses += 1;
    if (this.stormMode) {
      member.lostAt ??= Date.now();
      void this.reconnect(member);
    }
  }

  /** Reconnect with the contract's backoff: 250 ms x 2^n, full jitter, cap 15 s. */
  private async reconnect(member: Member): Promise<void> {
    while (!this.closing) {
      member.attempts += 1;
      const cap = Math.min(15_000, 250 * 2 ** Math.min(member.attempts, 6));
      await new Promise((r) => setTimeout(r, Math.random() * cap));
      try {
        await member.client.connect(true);
        member.resumedAt = Date.now();
        return;
      } catch {
        // keep trying
      }
    }
  }

  /** The host of every session sends `fps` events a second. */
  startSending(fps: number): void {
    this.fps = fps;
    this.tick = performance.now();
    this.timer ??= setInterval(() => {
      const now = performance.now();
      const dt = (now - this.tick) / 1000;
      this.tick = now;
      for (const session of this.sessions) {
        session.credit += this.fps * dt;
        const host = session.members[0]?.client;
        while (session.credit >= 1) {
          session.credit -= 1;
          host?.sendEvent('message.user');
        }
      }
    }, 50);
  }

  stopSending(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  totalSent(): number {
    let n = 0;
    for (const s of this.sessions) n += s.members[0]?.client.sent ?? 0;
    return n;
  }

  totalDelivered(): number {
    let n = 0;
    for (const s of this.sessions) for (const m of s.members) n += m.client.delivered;
    return n;
  }

  /** Members behind the newest seq of their session, members waiting on a gap, duplicate frames. */
  lossCheck(): {
    sessions: number;
    membersBehind: number;
    membersWithGap: number;
    duplicates: number;
  } {
    let behind = 0;
    let gap = 0;
    let dups = 0;
    for (const s of this.sessions) {
      const top = Math.max(0, ...s.members.map((m) => m.client.lastSeq));
      for (const m of s.members) {
        if (!m.client.everWelcomed) continue; // never connected: counted as a connect failure
        if (m.client.lastSeq < top) behind += 1;
        if (m.client.pendingGap > 0) gap += 1;
        dups += m.client.duplicates;
      }
    }
    return {
      sessions: this.sessions.length,
      membersBehind: behind,
      membersWithGap: gap,
      duplicates: dups,
    };
  }

  /** What `welcome.resume` said to each reconnected member, counted by state. */
  resumeStates(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.sessions) {
      for (const m of s.members) {
        const r = m.client.lastResume as { state?: string } | null | undefined;
        const key = r === undefined || r === null ? 'none' : (r.state ?? JSON.stringify(r));
        out[key] = (out[key] ?? 0) + 1;
      }
    }
    return out;
  }

  /** Seconds after `crashAt` (epoch ms) at which each lost member was welcome again; null: never. */
  resumeSeconds(crashAt: number): (number | null)[] {
    const out: (number | null)[] = [];
    for (const s of this.sessions) {
      for (const m of s.members)
        out.push(m.resumedAt === undefined ? null : (m.resumedAt - crashAt) / 1000);
    }
    return out;
  }

  closeAll(): void {
    this.closing = true;
    this.stopSending();
    for (const s of this.sessions) for (const m of s.members) m.client.close();
  }
}
