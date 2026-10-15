#!/usr/bin/env node
// Post-deploy smoke checks (B092): does the version that was just started answer as it should?
//
//   node infra/deploy/smoke.mjs --api <http url> --relay <ws url> [--env stage|production]
//                               [--timeout-ms 5000]
//
// Checks, in order (each with its own timeout; all run even if one fails):
//   healthz       GET  <api>/healthz            200
//   readyz        GET  <api>/readyz             200 (database, Redis and keys reachable)
//   status        GET  <api>/v1/status          200, JSON with a "status" field (CT-STATUS)
//   jwks          GET  <api>/.well-known/jwks.json   200, at least one key (the relay verifies
//                                               tickets against it)
//   device-code   POST <api>/v1/auth/device/code     200 with a device_code (CT-AUTH sign-in starts)
//   relay-upgrade GET  <relay> as a WebSocket upgrade  101 Switching Protocols (the relay accepts
//                                               connections; the socket is closed at once)
//
// Prints one JSON line per check ({check, ok, status, ms, detail}) and a summary line. No token,
// key or body is printed. Exit codes: 0 every check passed; 20 a check failed; 2 usage.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_SMOKE_FAILED = 20;

/**
 * @typedef {{ api: string, relay: string, env?: string, timeoutMs: number }} SmokeOptions
 * @typedef {{ check: string, ok: boolean, status: number | null, ms: number,
 *   detail: string | null }} SmokeResult
 * @typedef {{ status: number, body: string }} Answer
 */

/**
 * @param {string[]} argv
 * @returns {SmokeOptions | null}
 */
function parseArgs(argv) {
  let api = '';
  let relay = '';
  let env = 'stage';
  let timeoutMs = 5000;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--api') api = next();
    else if (a === '--relay') relay = next();
    else if (a === '--env') env = next();
    else if (a === '--timeout-ms') timeoutMs = Number(next());
    else return null;
  }
  if (!api || !relay || !Number.isFinite(timeoutMs)) return null;
  return { api, relay, env, timeoutMs };
}

/**
 * One HTTP(S) request; resolves {status, body} or rejects on timeout or a connection error.
 * @param {string} url
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, timeoutMs: number,
 *   upgrade?: boolean }} options
 * @returns {Promise<Answer>}
 */
function call(url, { method = 'GET', body, headers = {}, timeoutMs, upgrade = false }) {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const secure = u.protocol === 'https:' || u.protocol === 'wss:';
    const send = secure ? httpsRequest : httpRequest;
    const req = send(
      {
        hostname: u.hostname,
        port: u.port || (secure ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (text.length < 65536) text += chunk;
        });
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: text }));
      },
    );
    if (upgrade) {
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolvePromise({ status: res.statusCode ?? 101, body: '' });
      });
    }
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * @param {string} text
 * @returns {any}
 */
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The checks against `opts`; each resolves {check, ok, status, ms, detail}.
 * @param {SmokeOptions} opts
 * @returns {Promise<SmokeResult[]>}
 */
export async function runSmoke(opts) {
  const api = opts.api.replace(/\/$/, '');
  /** @type {[string, () => Promise<Answer>, (r: Answer) => boolean][]} */
  const checks = [
    ['healthz', () => call(`${api}/healthz`, opts), (r) => r.status === 200],
    ['readyz', () => call(`${api}/readyz`, opts), (r) => r.status === 200],
    [
      'status',
      () => call(`${api}/v1/status`, opts),
      (r) => r.status === 200 && typeof json(r.body)?.status === 'string',
    ],
    [
      'jwks',
      () => call(`${api}/.well-known/jwks.json`, opts),
      (r) => r.status === 200 && (json(r.body)?.keys?.length ?? 0) > 0,
    ],
    [
      'device-code',
      () =>
        call(`${api}/v1/auth/device/code`, {
          ...opts,
          method: 'POST',
          body: { client_id: 'centcom-cli', scope: 'profile', device_name: 'deploy smoke' },
        }),
      (r) => r.status === 200 && typeof json(r.body)?.device_code === 'string',
    ],
    [
      'relay-upgrade',
      () =>
        call(opts.relay, {
          ...opts,
          upgrade: true,
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': randomBytes(16).toString('base64'),
          },
        }),
      (r) => r.status === 101,
    ],
  ];
  /** @type {SmokeResult[]} */
  const results = [];
  for (const [name, run, ok] of checks) {
    const started = Date.now();
    try {
      const r = await run();
      const pass = ok(r);
      results.push({
        check: name,
        ok: pass,
        status: r.status,
        ms: Date.now() - started,
        detail: pass ? null : `unexpected answer (status ${r.status})`,
      });
    } catch (err) {
      results.push({
        check: name,
        ok: false,
        status: null,
        ms: Date.now() - started,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const opts = parseArgs(argv);
  if (opts === null) {
    process.stderr.write(
      'usage: smoke.mjs --api <http url> --relay <ws url> [--env stage|production] [--timeout-ms n]\n',
    );
    return 2;
  }
  const results = await runSmoke(opts);
  for (const r of results) process.stdout.write(`${JSON.stringify(r)}\n`);
  const failed = results.filter((r) => !r.ok).map((r) => r.check);
  process.stdout.write(
    `${JSON.stringify({ smoke: failed.length === 0 ? 'pass' : 'fail', env: opts.env, failed })}\n`,
  );
  return failed.length === 0 ? 0 : EXIT_SMOKE_FAILED;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
