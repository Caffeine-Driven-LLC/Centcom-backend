/**
 * Component probes (B086): what each STATUS_COMPONENTS entry's probe says, with at most one probe
 * round per component every 15 s across all API instances.
 *
 * - **One round per 15 s, cluster-wide:** an instance probes a component only when it wins
 *   `status:probe:{component}` (set-if-absent, 15 s TTL) in Redis; every other instance reads the
 *   component's state as the winner left it.
 * - **Probes:** a URL is up when a GET answers 2xx within 2 s; a heartbeat when its Redis key holds
 *   a time (epoch milliseconds) at most `max_age_s` old. A component without a probe is
 *   `operational`.
 * - **State:** the status with its hysteresis counters (`aggregate.ts`) lives in
 *   `status:probe-state:{component}` for an hour, so instances agree and a restart keeps it.
 *
 * Owns: probing and the probe keys. Must not: wait longer than the probe timeout, or put a URL, a
 * key or an error into anything it returns.
 */
import { noopMetrics, type KeyValue, type Metrics } from '@centcom/core';
import {
  INITIAL_PROBE_STATE,
  nextProbeState,
  type ComponentStatus,
  type ProbeState,
} from './aggregate.js';
import type { StatusComponent } from './config.js';

/** How long one probe may take. */
export const PROBE_TIMEOUT_MS = 2000;
/** How long a probe round counts, cluster-wide. */
export const PROBE_ROUND_MS = 15_000;
/** How long a component's state is kept between rounds. */
export const PROBE_STATE_TTL_MS = 60 * 60 * 1000;

/** The round key of a component (card B086: `status:probe:{component}`, 15 s). */
export const probeKey = (id: string): string => `status:probe:${id}`;
/** The state key of a component. */
export const probeStateKey = (id: string): string => `status:probe-state:${id}`;

/** A component as the feed shows it. */
export interface ComponentReport {
  id: string;
  name: string;
  status: ComponentStatus;
}

/** True when a GET of `url` answers 2xx within `timeoutMs`. Never throws. */
export async function httpUp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** What the prober needs. */
export interface ProberDeps {
  components: readonly StatusComponent[];
  kv: Pick<KeyValue, 'get' | 'set' | 'setIfAbsent'>;
  /** Default `httpUp`. */
  http?: (url: string, timeoutMs: number) => Promise<boolean>;
  /** Milliseconds; default Date.now. */
  clock?: () => number;
  /** Default PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
  metrics?: Metrics;
}

const parseState = (raw: string | null): ProbeState | null => {
  if (raw === null) return null;
  try {
    const s = JSON.parse(raw) as Partial<ProbeState>;
    return typeof s.status === 'string' &&
      typeof s.failures === 'number' &&
      typeof s.successes === 'number'
      ? (s as ProbeState)
      : null;
  } catch {
    return null;
  }
};

/** Probes components. */
export class ComponentProber {
  readonly #http: (url: string, timeoutMs: number) => Promise<boolean>;
  readonly #clock: () => number;
  readonly #timeoutMs: number;
  readonly #metrics: Metrics;

  constructor(private readonly deps: ProberDeps) {
    this.#http = deps.http ?? httpUp;
    this.#clock = deps.clock ?? Date.now;
    this.#timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  /** Every component's status, probed where this instance wins the round. Rejects if Redis does. */
  statuses(): Promise<ComponentReport[]> {
    return Promise.all(
      this.deps.components.map(async (c) => ({
        id: c.id,
        name: c.name,
        status: await this.#status(c),
      })),
    );
  }

  async #status(component: StatusComponent): Promise<ComponentStatus> {
    if (component.probe === null) return 'operational';
    const { kv } = this.deps;
    const won = await kv.setIfAbsent(probeKey(component.id), String(this.#clock()), PROBE_ROUND_MS);
    const previous = parseState(await kv.get(probeStateKey(component.id)));
    if (!won) return (previous ?? INITIAL_PROBE_STATE).status;
    const ok = await this.#probe(component);
    this.#metrics.counter('status_probes_total', { component: component.id, ok: String(ok) }).inc();
    const state = nextProbeState(previous ?? INITIAL_PROBE_STATE, ok);
    await kv.set(probeStateKey(component.id), JSON.stringify(state), { ttlMs: PROBE_STATE_TTL_MS });
    return state.status;
  }

  async #probe(component: StatusComponent): Promise<boolean> {
    const probe = component.probe;
    if (probe === null) return true;
    if ('url' in probe) return this.#http(probe.url, this.#timeoutMs);
    try {
      const raw = await this.deps.kv.get(probe.heartbeat_key);
      const at = raw === null ? NaN : Number(raw);
      return Number.isFinite(at) && this.#clock() - at <= probe.max_age_s * 1000;
    } catch {
      return false;
    }
  }
}
