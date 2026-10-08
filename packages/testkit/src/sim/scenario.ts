/**
 * Scenario DSL (B011): a readable script of named clients in one session,
 *
 *   await scenario().connect('host').connect('guest', { role: 'viewer' })
 *     .send('host', 'reaction', { target, code: 'thumbs', op: 'add' })
 *     .expect('guest', (f) => f.k === 'reaction')
 *     .run();
 *
 * Steps run in order, each bounded by a timeout; a failing step fails the run with its number and
 * label. Without a `url` the run starts a LoopbackRelay and stops it afterwards. Every client gets
 * a fresh test ticket (a new member and device) on each connect, and all are closed at the end.
 *
 * Owns: sequencing steps over SimClients. Assertions beyond "a matching frame arrives" belong in
 * `step()` callbacks with the test's own expect.
 */
import { createIdGenerator } from '@centcom/contracts';
import {
  SimClient,
  type CloseInfo,
  type ConnectOpts,
  DEFAULT_TIMEOUT_MS,
  type SendResult,
} from './client.js';
import type { Clock } from './clock.js';
import type { Fault } from './faults.js';
import type { Frame, KindFrameType } from './frames.js';
import { LoopbackRelay, type LoopbackRelayOptions } from './loopback-relay.js';
import { mintTestTicket, type SessionRole } from './ticket.js';

/** Options of a scenario. */
export interface ScenarioOptions {
  /** The relay; default a LoopbackRelay started for the run. */
  url?: string;
  /** The session; default a new `ses_` id. */
  sid?: string;
  /** Bound of each step, in real milliseconds; default 5000. */
  timeoutMs?: number;
  /** Given to every client (and the LoopbackRelay the run starts). */
  clock?: Clock;
  /** Settings of the LoopbackRelay the run starts. */
  relay?: LoopbackRelayOptions;
}

/** How a named client connects. */
export interface ScenarioClientOptions {
  /** Default: the first client is the host, the others editors. */
  role?: SessionRole;
  caps?: string[];
  faults?: readonly Fault[];
  /** Any other connect option. */
  connect?: Partial<Omit<ConnectOpts, 'url' | 'ticket'>>;
}

/** What steps get. */
export interface ScenarioContext {
  readonly sid: string;
  readonly url: string;
  /** The LoopbackRelay of this run, when it started one. */
  readonly relay: LoopbackRelay | undefined;
  /** A connected client by name. */
  client(name: string): SimClient;
  /** Results of `send` steps, by the label given (default `<name>:<kind>:<n>`). */
  readonly sends: Map<string, SendResult>;
}

/** The outcome of a run. */
export interface ScenarioRun extends ScenarioContext {
  /** Frames each client processed, by name, at the end of the run. */
  readonly frames: Map<string, readonly Frame[]>;
}

/** A failed step: which one, and why (`cause`). */
export class ScenarioError extends Error {}
Object.defineProperty(ScenarioError.prototype, 'name', {
  value: 'ScenarioError',
  writable: true,
  configurable: true,
});

interface Step {
  label: string;
  run(ctx: ScenarioContext): Promise<unknown>;
}

/** Starts a scenario. */
export function scenario(opts: ScenarioOptions = {}): Scenario {
  return new Scenario(opts);
}

/** A script of steps; nothing happens until `run()`. */
export class Scenario {
  private readonly steps: Step[] = [];
  private readonly opts: ScenarioOptions;
  private readonly ids = createIdGenerator();
  private connects = 0;

  constructor(opts: ScenarioOptions) {
    this.opts = opts;
  }

  /** Connects a client called `name` (a new member and device) and completes its handshake. */
  connect(name: string, opts: ScenarioClientOptions = {}): this {
    const role = opts.role ?? (this.connects === 0 ? 'host' : 'editor');
    this.connects += 1;
    const mid = this.ids('mem');
    const dev = this.ids('dev');
    return this.add(`connect ${name} as ${role}`, async (ctx) => {
      const clients = (ctx as InternalContext).clients;
      if (clients.has(name)) throw new Error(`a client called ${name} is already connected`);
      const client = await SimClient.connect({
        ...opts.connect,
        url: ctx.url,
        ticket: () =>
          mintTestTicket({
            sid: ctx.sid,
            mid,
            dev,
            role,
            ...(opts.caps === undefined ? {} : { caps: opts.caps }),
          }),
        ...(opts.caps === undefined ? {} : { caps: opts.caps }),
        ...(opts.faults === undefined ? {} : { faults: opts.faults }),
        ...(this.opts.clock === undefined ? {} : { clock: this.opts.clock }),
        timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      clients.set(name, client);
    });
  }

  /** `name` sends a frame of `kind` and waits for its echo (sequenced kinds). */
  send(
    name: string,
    kind: string,
    p?: Record<string, unknown>,
    opts: { ct?: boolean; type?: KindFrameType; label?: string } = {},
  ): this {
    const label = opts.label ?? `${name}:${kind}:${this.steps.length + 1}`;
    return this.add(`${name} sends ${kind}`, async (ctx) => {
      const result = await ctx.client(name).send(kind, p, {
        ...(opts.ct === undefined ? {} : { ct: opts.ct }),
        ...(opts.type === undefined ? {} : { type: opts.type }),
      });
      ctx.sends.set(label, result);
    });
  }

  /** Waits until `name` has processed a frame matching `pred`. */
  expect(
    name: string,
    pred: (frame: Frame) => boolean,
    opts: { label?: string; timeoutMs?: number } = {},
  ): this {
    return this.add(opts.label ?? `${name} receives a matching frame`, (ctx) =>
      ctx.client(name).waitFor(pred, opts.timeoutMs ?? this.opts.timeoutMs),
    );
  }

  /** Waits until `name`'s connection closes, with `code` when given. */
  expectClose(name: string, code?: number): this {
    return this.add(
      `${name} is closed${code === undefined ? '' : ` with ${code}`}`,
      async (ctx) => {
        const info: CloseInfo = await ctx.client(name).waitForClose(this.opts.timeoutMs);
        if (code !== undefined && info.code !== code)
          throw new Error(`closed with ${info.code}, expected ${code}`);
      },
    );
  }

  /** Closes `name`'s connection. */
  disconnect(name: string, code = 1000): this {
    return this.add(`${name} disconnects`, (ctx) => ctx.client(name).close(code));
  }

  /** Any other step: assertions, faults, reconnects. */
  step(label: string, fn: (ctx: ScenarioContext) => unknown): this {
    return this.add(label, async (ctx) => fn(ctx));
  }

  /** Runs the steps in order, then closes every client (and the relay it started). */
  async run(): Promise<ScenarioRun> {
    const relay =
      this.opts.url === undefined
        ? await LoopbackRelay.start({
            ...this.opts.relay,
            ...(this.opts.clock === undefined ? {} : { clock: this.opts.clock }),
          })
        : undefined;
    const clients = new Map<string, SimClient>();
    const ctx: InternalContext = {
      sid: this.opts.sid ?? this.ids('ses'),
      url: this.opts.url ?? relay?.url ?? '',
      relay,
      clients,
      sends: new Map(),
      client(name) {
        const client = clients.get(name);
        if (client === undefined) throw new Error(`no client called ${name} (connect it first)`);
        return client;
      },
    };
    try {
      for (const [i, step] of this.steps.entries()) {
        try {
          await step.run(ctx);
        } catch (err) {
          throw new ScenarioError(
            `step ${i + 1} (${step.label}) failed: ${(err as Error).message}`,
            { cause: err },
          );
        }
      }
      return {
        ...ctx,
        frames: new Map([...clients].map(([name, client]) => [name, [...client.frames]])),
      };
    } finally {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
      await relay?.close();
    }
  }

  private add(label: string, run: (ctx: ScenarioContext) => Promise<unknown>): this {
    this.steps.push({ label, run });
    return this;
  }
}

interface InternalContext extends ScenarioContext {
  readonly clients: Map<string, SimClient>;
}
