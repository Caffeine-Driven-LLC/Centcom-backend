/**
 * Protocol and capability negotiation (B038, CT-VER): the protocol is the highest version both the
 * client (`hello.p.protocols`) and this relay speak; the capabilities are those both advertise
 * (unknown ones are ignored, CT-VER's robustness rule); a client whose `client.version` is older
 * than `RELAY_MIN_CLIENT_VERSION`, or that speaks no protocol this relay does, is too old (close
 * 4426, `client_too_old`).
 *
 * Owns: the negotiation and semver comparison. Must not: grant a capability the client did not ask
 * for.
 */

/** The protocol majors this relay speaks (CT-WS-ENVELOPE `v`). */
export const SERVER_PROTOCOLS: readonly number[] = Object.freeze([1]);

/** What `sys.hello.p` carries (CT-WS-ENVELOPE), after schema validation. */
export interface Hello {
  protocols: readonly number[];
  caps?: readonly string[];
  ticket: string;
  client: { name: string; version: string; contract?: string };
  last_seq?: number | null;
}

/** What this relay offers. */
export interface ServerCaps {
  protocols: readonly number[];
  caps: readonly string[];
  /** Semver; older clients are refused. */
  minClientVersion: string;
}

/** A parsed semver version: numbers, and the pre-release part if any. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

const SEMVER =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `value` as a semver version, or undefined. */
export function parseVersion(value: unknown): Version | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const m = SEMVER.exec(value);
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

/** Compares two pre-release parts by semver's rules (numeric identifiers numerically). */
function comparePre(a: string, b: string): number {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1 by semver precedence (build metadata ignored). */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return comparePre(a.pre, b.pre);
}

/**
 * The protocol and capabilities for `hello`, or `too_old` when the client speaks no protocol this
 * relay does or its version is older than the minimum (an unparseable version counts as too old).
 */
export function negotiate(
  hello: Pick<Hello, 'protocols' | 'caps' | 'client'>,
  server: ServerCaps,
): { protocol: number; caps: string[] } | 'too_old' {
  const shared = hello.protocols.filter((p) => server.protocols.includes(p));
  if (shared.length === 0) return 'too_old';
  const version = parseVersion(hello.client.version);
  const minimum = parseVersion(server.minClientVersion);
  if (version === undefined || minimum === undefined || compareVersions(version, minimum) < 0) {
    return 'too_old';
  }
  const asked = new Set(hello.caps ?? []);
  return {
    protocol: Math.max(...shared),
    caps: server.caps.filter((cap) => asked.has(cap)),
  };
}
