/**
 * Where a load test may point (B095). The runner refuses anything else before it opens a socket:
 * `localhost`, loopback addresses, and `*.stage.centcom.dev`. Production host names, and every
 * other host, exit with code 2.
 */

/** Thrown for a target that is not allowed; the CLI exits 2. */
export class TargetRefusedError extends Error {
  constructor(target: string) {
    super(
      `refusing to run against "${target}": load tests may only target localhost, a loopback address or *.stage.centcom.dev`,
    );
    this.name = 'TargetRefusedError';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The host name of `target`, which may be a URL (ws://host:1234/path) or a bare `host[:port]`. */
export function hostOf(target: string): string {
  const text = target.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return new URL(text).hostname.toLowerCase();
  } catch {
    return '';
  }
  const withoutPath = text.split('/')[0] ?? '';
  if (withoutPath.startsWith('['))
    return withoutPath.slice(0, withoutPath.indexOf(']') + 1).toLowerCase();
  return (withoutPath.split(':')[0] ?? '').toLowerCase();
}

/** True when `target` may be load tested. */
export function isAllowedTarget(target: string): boolean {
  const host = hostOf(target);
  if (host === '') return false;
  if (LOOPBACK.has(host)) return true;
  // exactly one label in front of stage.centcom.dev or more: api.stage.centcom.dev, relay.eu.stage.centcom.dev
  return /^([a-z0-9-]+\.)+stage\.centcom\.dev$/.test(host);
}

/** Throws `TargetRefusedError` unless `target` is allowed. */
export function assertAllowedTarget(target: string): void {
  if (!isAllowedTarget(target)) throw new TargetRefusedError(target);
}
