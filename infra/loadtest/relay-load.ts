/**
 * `pnpm loadtest:relay` (B095): load tests of the real relay on this machine.
 *
 *   pnpm loadtest:relay --profile smoke|ramp|soak|storm|crossnode [options]
 *
 * It starts throwaway Redis, Postgres and MinIO (Docker), the relay itself (three for crossnode)
 * and generator processes that connect synthetic clients in sessions of `--members` (default 5),
 * seeded into Postgres because the relay checks the live records at every handshake. It measures
 * what the card's thresholds ask for: end-to-end fan-out latency (p95 below 150 ms, p99 below
 * 400 ms), unexpected closes below 0.1 %, no frame lost (seq continuity of every client), plus the
 * relay's CPU and memory from /proc. All traffic is synthetic: ciphertext is random bytes.
 *
 * Profiles
 *   smoke      200 connections (40 sessions x 5), 2 frames/s per session, 30 s.
 *   ramp       500 connections, then +500 per step (--step), each held --hold seconds (default 20), up
 *              to --max-connections: it stops at the first step that breaks a threshold, and the
 *              answer is the last step that passed.
 *   rate       --connections (default 1 000) held, the sending rate raised step by step (0.25 to 16
 *              events/s per session): the highest sequenced frames/s that still passes.
 *   soak       --connections (default 2 000) for --duration seconds (default 600), one result per minute.
 *   storm      --connections (default 1 000) steady, then the relay is SIGKILLed and started again:
 *              how many clients are welcome again within 60 s, how fast, and whether any seq is missing.
 *   crossnode  --nodes (default 3) relays on one Redis; the members of every session spread over them.
 *
 * Safety: the relay and everything it needs run on localhost (a target must be localhost or
 * *.stage.centcom.dev, exit 2 otherwise); no generator process holds more than 5 000 connections
 * (more are spread over more processes, and the machine must have the cores for them); every window
 * reports the generators' own event-loop lag, so a saturated generator is not mistaken for a slow
 * relay. Exit 0 all thresholds passed, 1 one failed, 2 usage or a refused target.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerStats, startBacking, type Backing } from './backing.js';
import { Histogram } from './hist.js';
import { busyCores, processJiffies, readCpuStat, CLOCK_TICKS } from './machine.js';
import { RelayProcess, startJwks } from './relay-process.js';
import { round } from './stats.js';
import { assertAllowedTarget, TargetRefusedError } from './targets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
export const MAX_CONNECTIONS_PER_PROCESS = 5_000;
/** A window is unusable when the whole machine is busier than this share of its cores: processes then queue for a core. */
export const MAX_MACHINE_BUSY = 0.65;

/** The card's thresholds. */
export const THRESHOLDS = {
  p95Ms: 150,
  p99Ms: 400,
  unexpectedCloseRatio: 0.001,
  /** Delivered / expected within a window; in-flight frames at its edges cost up to ~1 %. */
  deliveryRatio: 0.98,
  generatorLagP99Ms: 100,
  resumeWithinS: 60,
  resumeRatio: 0.999,
} as const;

interface Options {
  profile: string;
  members: number;
  connections: number;
  step: number;
  hold: number;
  maxConnections: number;
  duration: number;
  fps: number;
  nodes: number;
  out: string | undefined;
  url: string | undefined;
}

function parse(argv: readonly string[]): Options {
  const o: Options = {
    profile: 'smoke',
    members: 5,
    connections: 0,
    step: 500,
    hold: 20,
    maxConnections: 20_000,
    duration: 0,
    fps: 0,
    nodes: 3,
    out: undefined,
    url: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    const num = (): number => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
      i += 1;
      return n;
    };
    switch (flag) {
      case '--profile':
        o.profile = value ?? '';
        i += 1;
        break;
      case '--members':
        o.members = num();
        break;
      case '--connections':
        o.connections = num();
        break;
      case '--step':
        o.step = num();
        break;
      case '--hold':
        o.hold = num();
        break;
      case '--max-connections':
        o.maxConnections = num();
        break;
      case '--duration':
        o.duration = num();
        break;
      case '--fps':
        o.fps = num();
        break;
      case '--nodes':
        o.nodes = num();
        break;
      case '--out':
        o.out = value;
        i += 1;
        break;
      case '--url':
        o.url = value;
        i += 1;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  if (!['smoke', 'ramp', 'rate', 'soak', 'storm', 'crossnode'].includes(o.profile)) {
    throw new Error(`unknown profile "${o.profile}" (smoke, ramp, rate, soak, storm, crossnode)`);
  }
  return o;
}

/** The generator processes. */
class Workers {
  private readonly procs: ChildProcess[] = [];
  private seq = 0;
  private readonly waiting = new Map<number, (m: Record<string, unknown>) => void>();

  async start(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const child = fork(join(HERE, 'worker.ts'), [], {
        execArgv: ['--import', 'tsx'],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.test.json'),
          NODE_ENV: 'development',
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      child.on('message', (m: Record<string, unknown>) => {
        const done = this.waiting.get(Number(m['id']));
        if (done !== undefined) {
          this.waiting.delete(Number(m['id']));
          done(m);
        }
      });
      this.procs.push(child);
      await new Promise<void>((resolve) => {
        const ready = (m: Record<string, unknown>): void => {
          if (m['ready'] === true) {
            child.off('message', ready);
            resolve();
          }
        };
        child.on('message', ready);
      });
    }
  }

  get size(): number {
    return this.procs.length;
  }

  get pids(): (number | undefined)[] {
    return this.procs.map((p) => p.pid);
  }

  call(i: number, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proc = this.procs[i];
    if (proc === undefined) throw new RangeError(`no worker ${i}`);
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (m) =>
        typeof m['error'] === 'string' ? reject(new Error(String(m['error']))) : resolve(m),
      );
      proc.send({ ...msg, id });
    });
  }

  all(msg: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return Promise.all(this.procs.map((_, i) => this.call(i, msg)));
  }

  kill(): void {
    for (const p of this.procs) p.kill('SIGKILL');
  }
}

export interface StepResult {
  connections: number;
  sessions: number;
  seconds: number;
  framesSent: number;
  deliveries: number;
  deliveryRatio: number;
  deliveriesPerS: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  unexpectedCloses: number;
  relayCpuCores: number;
  relayRssMiB: number;
  generatorLagP99Ms: number;
  loadavg1: number;
  fps: number;
  sequencedFramesPerS: number;
  /** Cores kept busy by other work on this machine during the window (machine total minus ours). */
  foreignCores: number;
  /** Cores kept busy on the whole machine during the window. */
  machineBusyCores: number;
  noisy: boolean;
  membersBehind: number;
  membersWithGap: number;
  /** CPU of the Docker containers at mid-window (percent of one core). */
  backing?: { redisCpuPercent: number; postgresCpuPercent: number; minioCpuPercent: number };
  ok: boolean;
  failed: string[];
}

/** Holds the load for `seconds` and measures the window across all generators and relays. */
async function measure(
  workers: Workers,
  relays: RelayProcess[],
  seconds: number,
  fps: number,
  backing?: Backing,
): Promise<StepResult> {
  await workers.all({ t: 'window' });
  const cpuStart = readCpuStat();
  const workerJiffies0 = workers.pids.map(processJiffies);
  for (const relay of relays) relay.sample(); // arm the CPU delta
  const cpu: number[] = [];
  let rss = 0;
  const started = performance.now();
  const sampler = setInterval(() => {
    let cores = 0;
    let mem = 0;
    for (const relay of relays) {
      const s = relay.sample();
      if (s !== undefined) {
        cores += s.cpuCores;
        mem += s.rssMiB;
      }
    }
    cpu.push(cores);
    rss = Math.max(rss, mem);
  }, 1000);
  await new Promise((r) => setTimeout(r, (seconds * 1000) / 2));
  // the backing services' load at mid-window (docker stats takes about a second)
  const services =
    backing === undefined
      ? undefined
      : {
          redisCpuPercent: containerStats(backing.containers.redis).cpuPercent,
          postgresCpuPercent: containerStats(backing.containers.postgres).cpuPercent,
          minioCpuPercent: containerStats(backing.containers.minio).cpuPercent,
        };
  await new Promise((r) => setTimeout(r, (seconds * 1000) / 2));
  clearInterval(sampler);
  const elapsed = (performance.now() - started) / 1000;
  const cpuEnd = readCpuStat();
  const workerCores =
    workers.pids.map(processJiffies).reduce((n, j, i) => n + (j - (workerJiffies0[i] ?? 0)), 0) /
    CLOCK_TICKS /
    elapsed;
  const parts = await workers.all({ t: 'collect' });
  const hist = new Histogram();
  let connections = 0,
    sent = 0,
    delivered = 0,
    closes = 0,
    sessions = 0,
    lag = 0;
  for (const p of parts) {
    connections += Number(p['connections']);
    sent += Number(p['sent']);
    delivered += Number(p['delivered']);
    closes += Number(p['closes']);
    sessions += Number(p['sessions']);
    lag = Math.max(lag, Number(p['lagP99']));
    hist.merge(Histogram.from(p['hist'] as { counts: number[]; max: number }));
  }
  const members = sessions === 0 ? 1 : Math.round(connections / sessions);
  const expected = sent * members;
  const result: StepResult = {
    connections,
    sessions,
    seconds: round(elapsed),
    framesSent: sent,
    deliveries: delivered,
    deliveryRatio: expected === 0 ? 1 : round(delivered / expected, 4),
    deliveriesPerS: round(delivered / elapsed, 0),
    p50Ms: round(hist.percentile(50)),
    p95Ms: round(hist.percentile(95)),
    p99Ms: round(hist.percentile(99)),
    maxMs: round(hist.max),
    unexpectedCloses: closes,
    relayCpuCores: round(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length), 2),
    relayRssMiB: round(rss, 0),
    generatorLagP99Ms: round(lag),
    loadavg1: round(loadavg()[0] ?? 0, 1),
    fps,
    sequencedFramesPerS: round(sent / elapsed, 0),
    foreignCores: 0,
    machineBusyCores: 0,
    noisy: false,
    ...(services === undefined ? {} : { backing: services }),
    membersBehind: 0,
    membersWithGap: 0,
    ok: true,
    failed: [],
  };
  // frame loss: stop sending, let the relay drain for 3 s, then every client must have every seq
  await workers.all({ t: 'stop-send' });
  await new Promise((r) => setTimeout(r, 3000));
  for (const p of await workers.all({ t: 'loss' })) {
    const l = p['loss'] as { membersBehind: number; membersWithGap: number };
    result.membersBehind += l.membersBehind;
    result.membersWithGap += l.membersWithGap;
  }
  await workers.all({ t: 'send', fps });
  const dockerCores =
    services === undefined
      ? 0
      : (services.redisCpuPercent + services.postgresCpuPercent + services.minioCpuPercent) / 100;
  result.foreignCores = round(
    Math.max(0, busyCores(cpuStart, cpuEnd) - result.relayCpuCores - workerCores - dockerCores),
    1,
  );
  result.machineBusyCores = round(busyCores(cpuStart, cpuEnd), 1);
  result.noisy = result.machineBusyCores > MAX_MACHINE_BUSY * cpus().length;
  const fail = (why: string): void => {
    result.ok = false;
    result.failed.push(why);
  };
  if (result.p95Ms >= THRESHOLDS.p95Ms) fail(`p95 ${result.p95Ms} ms >= ${THRESHOLDS.p95Ms}`);
  if (result.p99Ms >= THRESHOLDS.p99Ms) fail(`p99 ${result.p99Ms} ms >= ${THRESHOLDS.p99Ms}`);
  if (connections > 0 && closes / connections > THRESHOLDS.unexpectedCloseRatio)
    fail(`${closes} unexpected closes of ${connections} connections`);
  if (result.deliveryRatio < THRESHOLDS.deliveryRatio)
    fail(`delivered ${result.deliveryRatio} of the expected frames`);
  if (result.generatorLagP99Ms >= THRESHOLDS.generatorLagP99Ms) {
    fail(
      `the load generator itself lagged (p99 ${result.generatorLagP99Ms} ms): the result says nothing about the relay`,
    );
  }
  return result;
}

/**
 * `measure`, repeated (up to four windows, 20 s apart) while the machine is busier
 * than MAX_MACHINE_BUSY of its cores: a number taken beside a build is not the relay's. If the machine never
 * calms down the best window is returned flagged `noisy`, and the step fails as inconclusive.
 */
async function measureSteady(
  workers: Workers,
  relays: RelayProcess[],
  seconds: number,
  fps: number,
  backing?: Backing,
): Promise<StepResult> {
  let best: StepResult | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const step = await measure(workers, relays, seconds, fps, backing);
    if (!step.noisy) return step;
    process.stderr.write(
      `  window ${attempt} was noisy (the machine kept ${step.machineBusyCores} of ${cpus().length} cores busy, ${step.foreignCores} of them on other work); measuring again\n`,
    );
    if (best === undefined || step.p95Ms < best.p95Ms) best = step;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  const last = best as StepResult;
  last.ok = false;
  last.failed.push(
    `inconclusive: the machine kept ${last.machineBusyCores} of ${cpus().length} cores busy in every window (limit ${MAX_MACHINE_BUSY * 100} %), ${last.foreignCores} of them on other work; run again when it is quiet`,
  );
  return last;
}

interface Report {
  scenario: string;
  started_at: string;
  target: string;
  environment: Record<string, string | number>;
  thresholds: { name: string; ok: boolean; value: number | string; limit: number | string }[];
  steps: StepResult[];
  extra: Record<string, unknown>;
  resources: Record<string, number>;
  passed: boolean;
}

function environment(workers: number): Record<string, string | number> {
  return {
    cpus: cpus().length,
    cpu_model: cpus()[0]?.model ?? 'unknown',
    memory_gib: round(totalmem() / 1024 ** 3, 1),
    kernel: release(),
    node: process.version,
    generator_processes: workers,
    relay: 'apps/relay/src/main.ts via tsx, one process per node',
    backing:
      'Redis 7 (AOF on), Postgres 16, MinIO in Docker on loopback; generators and relay share this machine',
  };
}

async function main(argv: readonly string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parse(argv);
  } catch (err) {
    process.stderr.write(
      `loadtest:relay: ${err instanceof Error ? err.message : 'bad arguments'}\n`,
    );
    return 2;
  }
  try {
    assertAllowedTarget(opts.url ?? 'ws://127.0.0.1');
  } catch (err) {
    if (err instanceof TargetRefusedError) {
      process.stderr.write(`loadtest:relay: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (opts.url !== undefined) {
    process.stderr.write(
      'loadtest:relay: --url (an existing relay) needs LOADTEST_TOKEN_MINT_URL, which this runner does not implement; it starts its own relay on localhost\n',
    );
    return 2;
  }
  const profile = opts.profile;
  const defaults: Record<string, number> = {
    smoke: 200,
    ramp: opts.maxConnections,
    soak: 2_000,
    storm: 1_000,
    crossnode: 1_500,
  };
  const connections = opts.connections || defaults[profile] || 200;
  const workerCount = Math.ceil(connections / MAX_CONNECTIONS_PER_PROCESS);

  const started = new Date();
  process.stderr.write('starting Redis, Postgres, MinIO...\n');
  const backing: Backing = await startBacking();
  const workers = new Workers();
  const nodes = profile === 'crossnode' ? opts.nodes : 1;
  const basePort = 18200 + (process.pid % 500);
  let jwks: Awaited<ReturnType<typeof startJwks>> | undefined;
  const relays: RelayProcess[] = [];
  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([workers.all({ t: 'close' })]);
    workers.kill();
    await Promise.all(relays.map((r) => r.stop()));
    jwks?.server.close();
    backing.stop();
  };
  process.once('SIGINT', () => void cleanup().then(() => process.exit(130)));

  let report: Report;
  try {
    process.stderr.write(
      `starting ${workerCount} generator process${workerCount > 1 ? 'es' : ''}...\n`,
    );
    await workers.start(workerCount);
    const inits = await workers.all({
      t: 'init',
      databaseUrl: backing.databaseUrl,
      members: opts.members,
    });
    // each generator signs its tickets with its own key: the relay trusts all of them
    const keys = inits.flatMap((m) => (m['jwks'] as { keys: unknown[] }).keys);
    jwks = await startJwks({ keys });
    for (let i = 0; i < nodes; i += 1)
      relays.push(
        new RelayProcess({ port: basePort + i, jwksUrl: jwks.url, backing, region: `n${i}` }),
      );
    process.stderr.write(`starting ${nodes} relay${nodes > 1 ? 's' : ''}...\n`);
    await Promise.all(relays.map((r) => r.start()));
    await workers.all({ t: 'start', urls: relays.map((r) => r.url) });

    const fps = opts.fps || { smoke: 2, ramp: 1, soak: 1, storm: 1, crossnode: 1 }[profile] || 1;
    report = {
      scenario: profile,
      started_at: started.toISOString(),
      target: 'localhost',
      environment: environment(workerCount),
      thresholds: [],
      steps: [],
      extra: {},
      resources: {},
      passed: false,
    };
    let connectFailures = 0;
    let retried = 0;
    const connectErrors: Record<string, number> = {};
    /** Grows the population to `total` connections, spread evenly over the generators. */
    const growTo = async (total: number): Promise<void> => {
      const per = Math.ceil(total / workers.size);
      const results = await workers.all({ t: 'grow', count: per });
      connectFailures = 0;
      retried = results.reduce((n, r) => n + Number(r['retries']), 0);
      for (const r of results) {
        connectFailures += Number(r['failures']);
        for (const [k, v] of Object.entries(r['errors'] as Record<string, number>))
          connectErrors[k] = (connectErrors[k] ?? 0) + v;
      }
    };
    const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let have = 0;

    if (profile === 'smoke' || profile === 'crossnode') {
      await growTo(connections);
      await workers.all({ t: 'send', fps });
      await settle(3000);
      report.steps.push(await measureSteady(workers, relays, opts.duration || 30, fps, backing));
    } else if (profile === 'ramp') {
      await workers.all({ t: 'send', fps });
      let target = Math.min(500, connections);
      let best = 0;
      for (;;) {
        // each generator adds the share of the new connections that belongs to it
        const add = Math.max(0, target - have);
        const per = Math.ceil(add / workers.size);
        const results = await workers.all({ t: 'grow', count: per });
        have = results.reduce((n, r) => n + Number(r['connections']), 0);
        retried = results.reduce((n, r) => n + Number(r['retries']), 0);
        connectFailures = 0;
        for (const r of results) {
          connectFailures += Number(r['failures']);
          for (const [k, v] of Object.entries(r['errors'] as Record<string, number>))
            connectErrors[k] = (connectErrors[k] ?? 0) + v;
        }
        await settle(2000);
        const step = await measureSteady(workers, relays, opts.hold, fps, backing);
        report.steps.push(step);
        process.stderr.write(
          `  ${step.connections} connections: p95 ${step.p95Ms} ms, p99 ${step.p99Ms} ms, ${step.deliveriesPerS}/s delivered, relay ${step.relayCpuCores} cores / ${step.relayRssMiB} MiB, ${step.ok ? 'ok' : `FAILED: ${step.failed.join('; ')}`}\n`,
        );
        if (!step.ok || connectFailures > 0) break;
        best = step.connections;
        if (target >= connections) break;
        target = Math.min(connections, target + opts.step);
      }
      report.extra['max_passing_connections'] = best;
    } else if (profile === 'rate') {
      await growTo(connections);
      let best = 0;
      let bestFps = 0;
      for (const f of [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]) {
        await workers.all({ t: 'send', fps: f });
        await settle(2000);
        const step = await measureSteady(workers, relays, opts.hold, f, backing);
        report.steps.push(step);
        process.stderr.write(
          `  ${step.sequencedFramesPerS} sequenced frames/s (${step.deliveriesPerS}/s delivered) on ${step.connections} connections: p95 ${step.p95Ms} ms, p99 ${step.p99Ms} ms, relay ${step.relayCpuCores} cores, ${step.ok ? 'ok' : `FAILED: ${step.failed.join('; ')}`}\n`,
        );
        if (!step.ok) break;
        best = step.sequencedFramesPerS;
        bestFps = f;
      }
      report.extra['max_passing_sequenced_frames_per_s'] = best;
      report.extra['max_passing_fps_per_session'] = bestFps;
    } else if (profile === 'soak') {
      await growTo(connections);
      await workers.all({ t: 'send', fps });
      await settle(3000);
      const total = opts.duration || 600;
      for (let elapsed = 0; elapsed < total; elapsed += 60) {
        const step = await measureSteady(
          workers,
          relays,
          Math.min(60, total - elapsed),
          fps,
          backing,
        );
        report.steps.push(step);
        process.stderr.write(
          `  minute ${elapsed / 60 + 1}: p95 ${step.p95Ms} ms, p99 ${step.p99Ms} ms, rss ${step.relayRssMiB} MiB\n`,
        );
      }
    } else {
      // storm
      await growTo(connections);
      await workers.all({ t: 'send', fps });
      await settle(3000);
      report.steps.push(await measureSteady(workers, relays, opts.hold, fps, backing));
      await workers.all({ t: 'storm', on: true });
      const crashAt = Date.now();
      process.stderr.write('killing the relay...\n');
      relays[0]?.crash();
      await settle(1000);
      await relays[0]?.start();
      const restarted = (Date.now() - crashAt) / 1000;
      const deadline = Date.now() + 120_000;
      let resumed: number[] = [];
      let total = 0;
      while (Date.now() < deadline) {
        const parts = await workers.all({ t: 'resumes', crashAt });
        const all = parts.flatMap((p) => p['seconds'] as (number | null)[]);
        total = all.length;
        resumed = all.filter((s): s is number => s !== null);
        if (resumed.length >= total) break;
        await settle(1000);
      }
      await settle(4000); // let the replay settle
      resumed.sort((a, b) => a - b);
      const within = resumed.filter((s) => s <= THRESHOLDS.resumeWithinS).length;
      const lossParts = await workers.all({ t: 'loss' });
      const loss = { sessions: 0, membersBehind: 0, membersWithGap: 0, duplicates: 0 };
      const states: Record<string, number> = {};
      for (const p of lossParts) {
        const l = p['loss'] as typeof loss;
        loss.sessions += l.sessions;
        loss.membersBehind += l.membersBehind;
        loss.membersWithGap += l.membersWithGap;
        loss.duplicates += l.duplicates;
        for (const [k, v] of Object.entries(p['states'] as Record<string, number>))
          states[k] = (states[k] ?? 0) + v;
      }
      report.extra['storm'] = {
        connections: total,
        relay_restart_seconds: round(restarted),
        resumed: resumed.length,
        resumed_within_60s: within,
        resumed_ratio_60s: round(within / Math.max(1, total), 4),
        resume_p50_s: round(resumed[Math.floor(resumed.length / 2)] ?? 0),
        resume_p95_s: round(resumed[Math.floor(resumed.length * 0.95)] ?? 0),
        resume_max_s: round(resumed[resumed.length - 1] ?? 0),
        resume_states: states,
        ...loss,
      };
      report.thresholds.push(
        {
          name: 'clients welcome again within 60 s',
          ok: within / Math.max(1, total) >= THRESHOLDS.resumeRatio,
          value: round(within / Math.max(1, total), 4),
          limit: THRESHOLDS.resumeRatio,
        },
        {
          name: 'members behind their session after the replay',
          ok: loss.membersBehind === 0,
          value: loss.membersBehind,
          limit: 0,
        },
        {
          name: 'members waiting on a seq gap',
          ok: loss.membersWithGap === 0,
          value: loss.membersWithGap,
          limit: 0,
        },
      );
      await workers.all({ t: 'storm', on: false });
    }
    report.extra['connect_failures'] = connectFailures;
    report.extra['handshake_retries_after_4503'] = retried;
    if (connectFailures > 0) report.extra['connect_errors'] = connectErrors;

    const limitSearchEarly = profile === 'ramp' || profile === 'rate';
    // sequence continuity of every client at the end of the run
    await workers.all({ t: 'stop-send' });
    await settle(3000);
    if (profile !== 'storm' && !limitSearchEarly) {
      const parts = await workers.all({ t: 'loss' });
      const loss = { sessions: 0, membersBehind: 0, membersWithGap: 0, duplicates: 0 };
      for (const p of parts) {
        const l = p['loss'] as typeof loss;
        loss.sessions += l.sessions;
        loss.membersBehind += l.membersBehind;
        loss.membersWithGap += l.membersWithGap;
        loss.duplicates += l.duplicates;
      }
      report.extra['loss_check'] = loss;
      report.thresholds.push({
        name: 'members behind their session at the end (frame loss)',
        ok: loss.membersBehind === 0 && loss.membersWithGap === 0,
        value: loss.membersBehind + loss.membersWithGap,
        limit: 0,
      });
    }

    const limitSearch = profile === 'ramp' || profile === 'rate';
    const wanted = limitSearch ? 0 : connections;
    report.thresholds.push({
      name: 'clients that could not connect',
      ok: limitSearch
        ? connectFailures === 0 || report.steps.length > 1
        : connectFailures / Math.max(1, wanted) <= THRESHOLDS.unexpectedCloseRatio &&
          (report.steps[0]?.connections ?? 0) > 0,
      value: connectFailures,
      limit: limitSearch
        ? 'none in the passing steps'
        : `${THRESHOLDS.unexpectedCloseRatio * 100} % of ${wanted}`,
    });
    for (const step of report.steps) {
      const label = `${step.connections} connections`;
      report.thresholds.push(
        {
          name: `${label}: fan-out p95 (ms)`,
          ok: step.p95Ms < THRESHOLDS.p95Ms,
          value: step.p95Ms,
          limit: THRESHOLDS.p95Ms,
        },
        {
          name: `${label}: fan-out p99 (ms)`,
          ok: step.p99Ms < THRESHOLDS.p99Ms,
          value: step.p99Ms,
          limit: THRESHOLDS.p99Ms,
        },
        {
          name: `${label}: unexpected closes`,
          ok:
            step.unexpectedCloses / Math.max(1, step.connections) <=
            THRESHOLDS.unexpectedCloseRatio,
          value: step.unexpectedCloses,
          limit: `${THRESHOLDS.unexpectedCloseRatio * 100} %`,
        },
        {
          name: `${label}: generator not saturated (lag p99 ms)`,
          ok: step.generatorLagP99Ms < THRESHOLDS.generatorLagP99Ms,
          value: step.generatorLagP99Ms,
          limit: THRESHOLDS.generatorLagP99Ms,
        },
      );
    }
    if (limitSearch) {
      // a ramp ends on its first failing step by design: it passes when at least one step passed,
      // and the failing step is recorded as the limit
      const best = Number(
        report.extra['max_passing_connections'] ??
          report.extra['max_passing_sequenced_frames_per_s'] ??
          0,
      );
      report.thresholds = report.thresholds.filter(
        (t) => t.ok || !/^\d+ connections:/.test(t.name),
      );
      report.thresholds.push({
        name: 'at least the first step passed',
        ok: best > 0,
        value: best,
        limit: '> 0',
      });
    }
    report.passed = report.thresholds.every((t) => t.ok);
    report.resources = {
      relay_rss_mib_max: Math.max(0, ...report.steps.map((s) => s.relayRssMiB)),
      relay_cpu_cores_max: Math.max(0, ...report.steps.map((s) => s.relayCpuCores)),
    };
  } finally {
    await cleanup();
  }

  const out =
    opts.out ??
    join(
      ROOT,
      'infra/loadtest/reports',
      `${started.toISOString().slice(0, 10)}-relay-${profile}.json`,
    );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${out}\n`);
  for (const t of report.thresholds.filter((x) => !x.ok))
    process.stderr.write(`FAILED ${t.name}: ${t.value} (limit ${t.limit})\n`);
  process.stderr.write(report.passed ? 'passed\n' : 'FAILED\n');
  return report.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
