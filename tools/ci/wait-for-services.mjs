// @ts-check
/**
 * Integration-job guard (B002): DATABASE_URL and REDIS_URL must be set, and each service must
 * accept a TCP connection within the time limit, before integration tests start.
 *
 * Usage: node tools/ci/wait-for-services.mjs   (reads DATABASE_URL and REDIS_URL; 60 s limit)
 */
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORTS = /** @type {Record<string, number>} */ ({
  'postgres:': 5432,
  'postgresql:': 5432,
  'redis:': 6379,
});

/**
 * Host and port from a service URL, or null when the URL is missing or not a known scheme.
 * @param {string | undefined} url
 * @returns {{ host: string, port: number } | null}
 */
export function endpointOf(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol];
  if (!u.hostname || port === undefined) return null;
  return { host: u.hostname, port };
}

/**
 * Resolves true once a TCP connection succeeds, false when `deadline` (epoch ms) passes first.
 * @param {{ host: string, port: number }} ep
 * @param {number} deadline
 * @returns {Promise<boolean>}
 */
export async function waitForTcp(ep, deadline) {
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = connect({ host: ep.host, port: ep.port, timeout: 2_000 });
      const done = (/** @type {boolean} */ v) => {
        socket.destroy();
        resolve(v);
      };
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    if (ok) return true;
    await sleep(1_000);
  }
  return false;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deadline = Date.now() + 60_000;
  let failed = false;
  for (const name of ['DATABASE_URL', 'REDIS_URL']) {
    const ep = endpointOf(process.env[name]);
    if (!ep) {
      console.error(`${name} is missing or not a postgres:// / redis:// URL.`);
      failed = true;
    } else if (!(await waitForTcp(ep, deadline))) {
      console.error(`${name}: ${ep.host}:${ep.port} did not accept a connection within 60 s.`);
      failed = true;
    } else {
      console.log(`${name}: ${ep.host}:${ep.port} reachable.`);
    }
  }
  if (failed) process.exit(1);
}
