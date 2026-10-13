/**
 * The chaos harness (B096): the API (`buildApp`) over a real Postgres and Redis with a fault proxy
 * in front of each, a token for a real user, steady-state probes, a write ledger, and an optional
 * `chaos-report.json` (CHAOS_REPORT=<path>) with one entry per scenario.
 *
 * Owns: wiring one API node to faultable backends and the probes. Must not: touch a database the
 * testkit did not make, or inject a fault outside the proxies and the containers it started.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRedis, defineConfig, z, type Env } from '@centcom/core';
import { closeDb, createDb } from '@centcom/db';
import { createFactories, startTestStack, type TestStack } from '@centcom/testkit';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Kysely } from 'kysely';
import { buildApp } from '../../src/app.js';
import { loadApiConfig } from '../../src/config.js';
import { createContext, type ApiDatabase, type AppContext } from '../../src/context.js';
import { SCOPES } from '../../src/modules/auth/tokens/service.js';
import { testEnv } from '../entrypoint/helpers.js';
import { captureLogger } from '../helpers.js';
import { TcpProxy, targetOf, through } from './proxy.js';

const settings = defineConfig(
  z.object({
    CHAOS: z.string().optional(),
    CHAOS_OUTAGE_S: z.string().optional(),
    CHAOS_REPORT: z.string().optional(),
  }),
);

/** True when the chaos experiments were asked for (`pnpm chaos`). */
export const CHAOS_ON = settings.CHAOS === '1';
/** How long an outage lasts, in seconds (default 8; the card's figure is 60). */
export const OUTAGE_S = Number(settings.CHAOS_OUTAGE_S ?? '8');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `check` every 250 ms; the time it took in ms, or null when `limitMs` passed first. */
export async function within(
  limitMs: number,
  check: () => Promise<boolean>,
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start <= limitMs) {
    if (await check().catch(() => false)) return Date.now() - start;
    await sleep(250);
  }
  return null;
}

/** One scenario's result as written to the report. */
export interface ScenarioReport {
  scenario: string;
  passed: boolean;
  steady_state_before: Record<string, unknown>;
  during: Record<string, unknown>;
  after: Record<string, unknown>;
  violations: string[];
}

/** Appends `report` to CHAOS_REPORT, when set. */
export function record(report: ScenarioReport): void {
  const path = settings.CHAOS_REPORT;
  if (path === undefined) return;
  const all: ScenarioReport[] = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as ScenarioReport[])
    : [];
  writeFileSync(
    path,
    JSON.stringify([...all.filter((r) => r.scenario !== report.scenario), report], null, 2),
  );
}

/** One API node with faultable Postgres and Redis. */
export interface Node {
  stack: TestStack;
  app: FastifyInstance;
  ctx: AppContext;
  dbProxy: TcpProxy;
  redisProxy: TcpProxy;
  auth: Record<string, string>;
  userId: string;
  deviceId: string;
  /** The ledger of workspace creates: every answer with the id it claims. */
  ledger: { status: number; id: string | null; at: number }[];
  get(url: string, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  post(url: string, payload: object, key?: string): Promise<LightMyRequestResponse>;
  createWorkspace(name?: string): Promise<LightMyRequestResponse>;
  /** Workspace ids the ledger saw created (201) that Postgres does not hold. */
  lost(): Promise<string[]>;
  stop(): Promise<void>;
}

/** Starts a node. `clock` and `env` shift this node's time or settings. */
export async function startNode(
  options: {
    clock?: () => number;
    env?: Record<string, string | undefined>;
    stack?: TestStack;
  } = {},
): Promise<Node> {
  const stack = options.stack ?? (await startTestStack());
  const dbProxy = new TcpProxy(targetOf(stack.databaseUrl));
  const redisProxy = new TcpProxy(targetOf(stack.redisUrl));
  await dbProxy.start();
  await redisProxy.start();
  const logger = captureLogger().logger;
  const dbUrl = through(stack.databaseUrl, dbProxy);
  const env: Env = testEnv({
    RATELIMIT_AUTH_LIMIT: '1000',
    RATELIMIT_ANONYMOUS_LIMIT: '1000',
    WORKSPACES_MAX_OWNED: '1000',
    DATABASE_URL: dbUrl,
    REDIS_URL: through(stack.redisUrl, redisProxy),
    ...options.env,
  });
  const config = loadApiConfig(env);
  const db = createDb<ApiDatabase>({ url: dbUrl, poolMax: 4, connectTimeoutMs: 1000, logger });
  const redis = createRedis({ url: config.base.redisUrl, keyPrefix: stack.redisKeyPrefix, logger });
  const deps = {
    config,
    db,
    redis,
    logger,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const ctx = createContext(deps);
  const app = await buildApp(deps);
  await app.ready();
  const factories = createFactories(stack.db);
  const user = await factories.users.create();
  const device = await factories.devices.create({ user });
  const issued = await ctx.tokens.issueTokens({
    userId: user.id,
    deviceId: device.id,
    scopes: SCOPES.filter((s) => s !== 'admin'),
  });
  const auth = { authorization: `Bearer ${issued.access_token}` };
  const ledger: Node['ledger'] = [];
  let counter = 0;
  const node: Node = {
    stack,
    app,
    ctx,
    dbProxy,
    redisProxy,
    auth,
    userId: user.id,
    deviceId: device.id,
    ledger,
    get: (url, headers = {}) =>
      app.inject({ method: 'GET', url, headers: { ...auth, ...headers } }),
    post: (url, payload, key = randomUUID()) =>
      app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': key }, payload }),
    async createWorkspace(name = `chaos ${Date.now()} ${(counter += 1)}`) {
      const res = await node.post('/v1/workspaces', { name });
      const id = res.statusCode === 201 ? res.json<{ id: string }>().id : null;
      ledger.push({ status: res.statusCode, id, at: Date.now() });
      return res;
    },
    async lost() {
      const claimed = ledger.flatMap((e) => (e.id === null ? [] : [e.id]));
      if (claimed.length === 0) return [];
      const rows = await (stack.db as unknown as Kysely<{ workspaces: { id: string } }>)
        .selectFrom('workspaces')
        .select('id')
        .where('id', 'in', claimed)
        .execute();
      const held = new Set(rows.map((r) => r.id));
      return claimed.filter((id) => !held.has(id));
    },
    async stop() {
      dbProxy.set('pass');
      redisProxy.set('pass');
      await app.close().catch(() => undefined);
      await Promise.allSettled([closeDb(db), redis.close()]);
      await Promise.allSettled([dbProxy.stop(), redisProxy.stop()]);
      if (options.stack === undefined) await stack.stop();
    },
  };
  return node;
}

/** Appends a line to CHAOS_LOG, when set (for debugging a run). */
export function note(line: string): void {
  const path = (
    defineConfig(z.object({ CHAOS_LOG: z.string().optional() })) as { CHAOS_LOG?: string }
  ).CHAOS_LOG;
  if (path !== undefined) appendFileSync(path, `${line}\n`);
}
