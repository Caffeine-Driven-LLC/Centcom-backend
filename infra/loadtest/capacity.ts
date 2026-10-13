/**
 * The capacity model (B095): turns what the load tests measured per relay instance into the number
 * of instances, servers and money a launch target needs, with one spare instance (N+1). It fails
 * when a measurement is older than 30 days, so a plan never rests on numbers from before the code
 * changed.
 *
 *   pnpm capacity:model --ramp <ramp report> [--rate r] [--crossnode r] [--storm r] [--soak r] [--out docs/capacity.md]
 *
 * What it does not know: the REST API's capacity (no API load test exists yet; the plan says so
 * instead of inventing a figure), Postgres and Redis sizing, and anything about hardware other than
 * the machine the reports were made on.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MEASUREMENT_AGE_DAYS = 30;

/** The launch targets of the card. */
export interface Targets {
  connections: number;
  sessions: number;
  sequencedFramesPerS: number;
  membersPerSession: number;
}
export const LAUNCH_TARGETS: Targets = {
  connections: 20_000,
  sessions: 2_000,
  sequencedFramesPerS: 5_000,
  membersPerSession: 5,
};

/** What was measured on one relay instance. */
export interface Measurements {
  /** When the load test ran (ISO). */
  measuredAt: string;
  machine: string;
  /** Connections one relay held while every threshold passed (at the report's per-session rate). */
  connectionsPerInstance: number;
  /** Per-session sending rate (events/s) of that ramp. */
  rampFpsPerSession: number;
  /** Connections at which the relay used 60 % of a core, from the ramp (interpolated). */
  connectionsAtCpu60: number;
  /** Sequenced frames/s one instance sustained within thresholds, with `membersPerSession` members. */
  framesPerSecondPerInstance: number | null;
  memoryBaseMiB: number;
  memoryMiBPerConnection: number;
  /** vCPU one relay instance uses (it is one Node process). */
  vcpuPerInstance: number;
}

/** A server type to buy. Edit the prices: they are list prices at the time of writing. */
export interface ServerType {
  name: string;
  vcpu: number;
  ramGiB: number;
  eurPerMonth: number;
}
export const PRICES: readonly ServerType[] = [
  { name: 'Hetzner CX22', vcpu: 2, ramGiB: 4, eurPerMonth: 4.5 },
  { name: 'Hetzner CX32', vcpu: 4, ramGiB: 8, eurPerMonth: 7.5 },
  { name: 'Hetzner CX42', vcpu: 8, ramGiB: 16, eurPerMonth: 16 },
  { name: 'Hetzner CX52', vcpu: 16, ramGiB: 32, eurPerMonth: 32 },
];

export interface PlanRow {
  multiplier: number;
  connections: number;
  sequencedFramesPerS: number;
  relayInstancesForConnections: number;
  relayInstancesForFrames: number | null;
  relayInstances: number;
  /** Instances including one spare (N+1). */
  relayInstancesWithSpare: number;
  relayVcpu: number;
  relayRamGiB: number;
  /** The cheapest set of servers that holds the relay instances plus a core and 2 GiB for the rest of the stack. */
  servers: { type: string; count: number; eurPerMonth: number };
  limitedBy: 'connections' | 'frames';
}
export interface InstancePlan {
  targets: Targets;
  measurements: Measurements;
  rows: PlanRow[];
  warnings: string[];
}

/** A measurement older than the limit. */
export class StaleMeasurementError extends Error {
  constructor(readonly ageDays: number) {
    super(
      `the load test is ${ageDays.toFixed(1)} days old; the limit is ${MAX_MEASUREMENT_AGE_DAYS}: run it again`,
    );
    this.name = 'StaleMeasurementError';
  }
}

/** The instance plan for `multipliers` times the launch targets. Throws `StaleMeasurementError`. */
export function plan(
  targets: Targets,
  m: Measurements,
  options: { multipliers?: readonly number[]; now?: Date; prices?: readonly ServerType[] } = {},
): InstancePlan {
  const now = options.now ?? new Date();
  const ageDays = (now.getTime() - new Date(m.measuredAt).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > MAX_MEASUREMENT_AGE_DAYS)
    throw new StaleMeasurementError(ageDays);
  const prices = [...(options.prices ?? PRICES)].sort((a, b) => a.eurPerMonth - b.eurPerMonth);
  const warnings: string[] = [];
  if (m.framesPerSecondPerInstance === null) {
    warnings.push(
      'No sending-rate test (profile rate) was given: instance counts rest on connections only and are optimistic for busy sessions.',
    );
  }
  warnings.push(
    'The REST API was not load tested (no API profile exists yet): the plan covers the relay only.',
  );
  const rows = (options.multipliers ?? [1, 2, 5]).map((multiplier): PlanRow => {
    const connections = targets.connections * multiplier;
    const frames = targets.sequencedFramesPerS * multiplier;
    const forConnections = Math.ceil(connections / m.connectionsAtCpu60);
    const forFrames =
      m.framesPerSecondPerInstance === null
        ? null
        : Math.ceil(frames / m.framesPerSecondPerInstance);
    const instances = Math.max(forConnections, forFrames ?? 0);
    const withSpare = instances + 1;
    const vcpu = withSpare * m.vcpuPerInstance;
    const ramGiB =
      (withSpare * (m.memoryBaseMiB + (connections / withSpare) * m.memoryMiBPerConnection)) / 1024;
    // the relays plus a core and 2 GiB for Caddy, API, worker, Postgres, Redis on the first server
    const needVcpu = vcpu + 1;
    const needRam = ramGiB + 2;
    let best: PlanRow['servers'] | undefined;
    for (const type of prices) {
      const count = Math.max(Math.ceil(needVcpu / type.vcpu), Math.ceil(needRam / type.ramGiB));
      const cost = count * type.eurPerMonth;
      if (best === undefined || cost < best.eurPerMonth)
        best = { type: type.name, count, eurPerMonth: round(cost) };
    }
    return {
      multiplier,
      connections,
      sequencedFramesPerS: frames,
      relayInstancesForConnections: forConnections,
      relayInstancesForFrames: forFrames,
      relayInstances: instances,
      relayInstancesWithSpare: withSpare,
      relayVcpu: vcpu,
      relayRamGiB: round(ramGiB),
      servers: best as PlanRow['servers'],
      limitedBy: forFrames !== null && forFrames > forConnections ? 'frames' : 'connections',
    };
  });
  return { targets, measurements: m, rows, warnings };
}

const round = (n: number): number => Math.round(n * 10) / 10;

interface Step {
  connections: number;
  relayCpuCores: number;
  relayRssMiB: number;
  ok: boolean;
  fps: number;
  sequencedFramesPerS: number;
}
interface Report {
  scenario: string;
  started_at: string;
  environment: Record<string, string | number>;
  steps: Step[];
  extra: Record<string, unknown>;
}

/** Measurements from a ramp report and, optionally, a rate report. */
export function measurementsFrom(ramp: Report, rate?: Report): Measurements {
  const passing = ramp.steps.filter((s) => s.ok);
  if (passing.length === 0) throw new Error('the ramp report has no passing step');
  const last = passing[passing.length - 1] as Step;
  // connections at 60 % of a core: interpolate the (connections, cpu) points of the ramp
  const points = ramp.steps
    .filter((s) => s.relayCpuCores > 0)
    .map((s) => [s.connections, s.relayCpuCores] as const);
  let at60 = last.connections;
  for (let i = 1; i < points.length; i += 1) {
    const [c0, u0] = points[i - 1] as readonly [number, number];
    const [c1, u1] = points[i] as readonly [number, number];
    if (u0 < 0.6 && u1 >= 0.6)
      at60 = Math.min(at60, Math.round(c0 + ((0.6 - u0) / (u1 - u0)) * (c1 - c0)));
  }
  const first = passing[0] as Step;
  const perConnection =
    passing.length > 1
      ? Math.max(0, (last.relayRssMiB - first.relayRssMiB) / (last.connections - first.connections))
      : 0.15;
  const base = Math.max(0, first.relayRssMiB - perConnection * first.connections);
  const ratePassing = rate?.steps.filter((s) => s.ok) ?? [];
  const frames =
    ratePassing.length === 0 ? null : Math.max(...ratePassing.map((s) => s.sequencedFramesPerS));
  const newest =
    [ramp, rate]
      .filter((r): r is Report => r !== undefined)
      .map((r) => r.started_at)
      .sort()[0] ?? ramp.started_at;
  return {
    measuredAt: newest, // the oldest of the reports it rests on
    machine: `${String(ramp.environment['cpu_model'])}, ${String(ramp.environment['cpus'])} cores, ${String(ramp.environment['memory_gib'])} GiB`,
    connectionsPerInstance: last.connections,
    rampFpsPerSession: last.fps,
    connectionsAtCpu60: Math.max(1, at60),
    framesPerSecondPerInstance: frames,
    memoryBaseMiB: Math.round(base),
    memoryMiBPerConnection: Math.round(perConnection * 1000) / 1000,
    vcpuPerInstance: 1,
  };
}

/** The load test reports a capacity document is made from. */
export interface Sources {
  ramp: { file: string; report: Report };
  rate?: { file: string; report: Report };
  crossnode?: { file: string; report: Report };
  storm?: { file: string; report: Report };
  soak?: { file: string; report: Report };
}

const num = (v: unknown): string => (typeof v === 'number' ? String(v) : 'n/a');
const stepTable = (r: Report, columns: 'ramp' | 'rate'): string[] => [
  columns === 'ramp'
    ? '| Connections | p95 ms | p99 ms | Delivered/s | Relay cores | Relay MiB | Result |'
    : '| Sequenced frames/s | Delivered/s | p95 ms | p99 ms | Relay cores | Result |',
  columns === 'ramp'
    ? '| --- | --- | --- | --- | --- | --- | --- |'
    : '| --- | --- | --- | --- | --- | --- |',
  ...r.steps.map((s) => {
    const x = s as unknown as Record<string, unknown>;
    const result = s.ok ? 'passed' : x['noisy'] === true ? 'inconclusive (machine busy)' : 'failed';
    return columns === 'ramp'
      ? `| ${s.connections} | ${num(x['p95Ms'])} | ${num(x['p99Ms'])} | ${num(x['deliveriesPerS'])} | ${s.relayCpuCores} | ${s.relayRssMiB} | ${result} |`
      : `| ${s.sequencedFramesPerS} | ${num(x['deliveriesPerS'])} | ${num(x['p95Ms'])} | ${num(x['p99Ms'])} | ${s.relayCpuCores} | ${result} |`;
  }),
];

/** The Markdown of docs/capacity.md for a plan. */
export function renderMarkdown(p: InstancePlan, sources: Sources): string {
  const m = p.measurements;
  const files = Object.values(sources)
    .map((s) => `\`${s.file}\``)
    .join(', ');
  const lines = [
    '<!-- GENERATED by `pnpm capacity:model` from the latest load test reports. Do not edit; run the load tests and the model again. -->',
    '',
    '# Capacity of the relay (one server)',
    '',
    `Measured ${m.measuredAt.slice(0, 10)} on ${m.machine}. Reports: ${files}. The planning figures are for **one relay process** (one Node process, one vCPU); the cluster numbers below multiply them, they were not measured at that scale.`,
    '',
    '## What one relay process holds',
    '',
    '| Measurement | Value |',
    '| --- | --- |',
    `| Connections held while every threshold passed (sessions of ${p.targets.membersPerSession}, ${m.rampFpsPerSession} event/s per session) | ${m.connectionsPerInstance} |`,
    `| Connections at 60 % of one core (the planning figure) | ${m.connectionsAtCpu60} |`,
    `| Sequenced frames/s within thresholds (${p.targets.membersPerSession} members, so ${p.targets.membersPerSession} times as many deliveries) | ${m.framesPerSecondPerInstance ?? 'not measured'} |`,
    `| Memory | about ${m.memoryBaseMiB} MiB plus ${m.memoryMiBPerConnection} MiB per connection |`,
    '',
    "Thresholds (the card's): fan-out p95 under 150 ms and p99 under 400 ms measured end to end from the sender to every member, under 0.1 % unexpected closes, every client holds every sequenced frame 3 s after the senders stop, and the machine was not busier than 65 % of its cores during the window (otherwise the window is repeated, and reported inconclusive if the machine never calms down).",
    '',
    '### Connections (profile `ramp`: +500 connections per step, 20 s each)',
    '',
    ...stepTable(sources.ramp.report, 'ramp'),
    '',
    ...(sources.rate === undefined
      ? []
      : [
          `### Sending rate (profile \`rate\`: ${sources.rate.report.steps[0]?.connections ?? ''} connections, the per-session rate raised step by step)`,
          '',
          ...stepTable(sources.rate.report, 'rate'),
          '',
        ]),
    ...(sources.storm === undefined
      ? []
      : [
          '### Reconnect storm (the relay process is killed with SIGKILL and started again)',
          '',
          '```json',
          JSON.stringify(sources.storm.report.extra['storm'], null, 2),
          '```',
          '',
        ]),
    ...(sources.crossnode === undefined
      ? []
      : [
          '### Several relays on one Redis (profile `crossnode`: the members of each session spread over the nodes)',
          '',
          ...stepTable(sources.crossnode.report, 'ramp'),
          '',
        ]),
    ...(sources.soak === undefined
      ? []
      : ['### Soak (one result per minute)', '', ...stepTable(sources.soak.report, 'ramp'), '']),
    '## Instances and cost for the launch targets',
    '',
    `Targets at 1x: ${p.targets.connections} connections, ${p.targets.sessions} sessions, ${p.targets.sequencedFramesPerS} sequenced frames/s. Each relay is one process (one vCPU); N+1 adds one spare. Servers are the cheapest set of the price table (\`infra/loadtest/capacity.ts\`, edit the prices: they are approximate list prices) holding the relays plus one core and 2 GiB for the rest of the stack.`,
    '',
    '| Load | Connections | Frames/s | Relays needed (connections / frames) | Limited by | With spare | vCPU | RAM GiB | Servers | EUR per month |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...p.rows.map(
      (r) =>
        `| ${r.multiplier}x | ${r.connections} | ${r.sequencedFramesPerS} | ${r.relayInstancesForConnections} / ${r.relayInstancesForFrames ?? 'n/a'} | ${r.limitedBy} | ${r.relayInstancesWithSpare} | ${r.relayVcpu} | ${r.relayRamGiB} | ${r.servers.count} x ${r.servers.type} | ${r.servers.eurPerMonth} |`,
    ),
    '',
    ...p.warnings.map((w) => `- ${w}`),
    '',
    '## How far to trust these numbers',
    '',
    '- **A laptop is not a server.** Everything ran on one machine: the relay, the load generators (2 to 5 Node processes), Redis, Postgres and MinIO in Docker, and whatever else the laptop was doing. The runner measures how busy the whole machine is and repeats a window that was too busy, but a laptop still has shared cores, frequency scaling and thermal limits that a dedicated server does not. Expect a Hetzner vCPU to differ in either direction; measure again there before buying for a launch.',
    '- **No network.** All traffic is on loopback: no latency, loss, TLS or bandwidth limits, and no Cloudflare or Caddy in the path. Real clients add their own round trip to every latency figure.',
    '- **One traffic shape.** One sender (the host) per session of 5, one event a second by default, 48-byte random ciphertext. Streaming assistant output is burstier and larger; use `--fps` and `--members` to try others.',
    '- **The durable history goes to a local MinIO**, not to R2/B2, so its latency under load is optimistic.',
    '- **Not measured:** the REST API, Postgres write throughput, the 20 000-connection and 5 000 frames/s targets themselves (the machine cannot host that many connections and generators together), multi-region routing.',
    '',
    '## Reproduce',
    '',
    '```sh',
    'pnpm loadtest:relay --profile ramp --step 500 --hold 20 --max-connections 6000 --out ramp.json',
    'pnpm loadtest:relay --profile rate --connections 1000 --hold 20 --out rate.json',
    'pnpm capacity:model --ramp ramp.json --rate rate.json',
    '```',
    '',
    'Docker is needed (Redis, Postgres, MinIO are started and removed by the runner). Close other heavy work first; the runner says when the machine was too busy.',
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const rampFile = arg('--ramp') ?? arg('--report');
  if (rampFile === undefined) {
    process.stderr.write(
      'usage: capacity:model --ramp <ramp report.json> [--rate r] [--crossnode r] [--storm r] [--soak r] [--out docs/capacity.md]\n',
    );
    process.exit(2);
  }
  try {
    const read = (file: string): Report => JSON.parse(readFileSync(file, 'utf8')) as Report;
    const rateFile = arg('--rate');
    const m = measurementsFrom(read(rampFile), rateFile === undefined ? undefined : read(rateFile));
    const result = plan(LAUNCH_TARGETS, m);
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const out = arg('--out') ?? join(root, 'docs/capacity.md');
    const rel = (f: string): string => f.replace(`${root}/`, '');
    const source = (flag: string): { file: string; report: Report } | undefined => {
      const f = arg(flag);
      return f === undefined ? undefined : { file: rel(f), report: read(f) };
    };
    const sources: Sources = { ramp: { file: rel(rampFile), report: read(rampFile) } };
    const rate = source('--rate');
    const crossnode = source('--crossnode');
    const storm = source('--storm');
    const soak = source('--soak');
    if (rate !== undefined) sources.rate = rate;
    if (crossnode !== undefined) sources.crossnode = crossnode;
    if (storm !== undefined) sources.storm = storm;
    if (soak !== undefined) sources.soak = soak;
    writeFileSync(out, renderMarkdown(result, sources));
    process.stdout.write(`${out}\n`);
  } catch (err) {
    process.stderr.write(`capacity:model: ${err instanceof Error ? err.message : 'failed'}\n`);
    process.exit(err instanceof StaleMeasurementError ? 1 : 2);
  }
}
