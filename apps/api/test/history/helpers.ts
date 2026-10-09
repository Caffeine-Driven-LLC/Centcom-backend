/**
 * Test helpers for the history store (B055): sequenced frames built from
 * `contracts/fixtures/events/` (encrypted, hybrid and clear samples) with fresh ids and the given
 * seq, a scripted `HistoryAccess`, a recording audit sink, an in-memory `HistoryStore` with the
 * real store's read rules (for the service and route tests that need no database), and the API on
 * the real request-context, error-handler and auth plugins with the history routes.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createIdGenerator, type IdPrefix } from '@centcom/contracts';
import { Secret, type AuditEvent, type SigningKeys } from '@centcom/core';
import { fastify, type FastifyInstance } from 'fastify';
import type {
  HistoryAccess,
  HistoryRead,
  HistoryStore,
  SessionStanding,
  StoredFrame,
} from '../../src/modules/history/index.js';
import { HistoryService, toStoredFrame } from '../../src/modules/history/index.js';
import { authPlugin } from '../../src/plugins/auth.js';
import { errorHandlerPlugin, frameworkErrorHandler } from '../../src/plugins/error-handler.js';
import { requestContextPlugin } from '../../src/plugins/request-context.js';
import { historyRoutes } from '../../src/routes/history/index.js';
import { captureLogger } from '../helpers.js';
import { memoryTokens } from '../modules/auth/tokens/helpers.js';

export const newId: (prefix: IdPrefix) => string = createIdGenerator();

/** Cursor signing keys for the tests. */
export const KEYS: SigningKeys = [
  { id: 'k1', secret: new Secret(new Uint8Array(randomBytes(32))) },
];

/** The fixture frame of `kind`. */
export function fixture(kind: string): Record<string, unknown> {
  const url = new URL(`../../../../contracts/fixtures/events/${kind}.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { frame: Record<string, unknown> }).frame;
}

/** A sequenced `message.user` (encrypted) frame of `sid` at `seq`, with `ct.c` when given. */
export function sequenced(
  sid: string,
  seq: number,
  opts: { kind?: string; c?: string; from?: string } = {},
): Record<string, unknown> & { t: string } {
  const base = fixture(opts.kind ?? 'message.user');
  const ct = base['ct'] as Record<string, unknown> | undefined;
  const frame: Record<string, unknown> = {
    ...base,
    id: newId('msg'),
    sid,
    from: opts.from ?? (base['from'] as string),
    seq,
    ts: new Date(Date.UTC(2026, 9, 8, 12, 0, 0) + seq).toISOString(),
    ...(ct === undefined ? {} : { ct: { ...ct, ...(opts.c === undefined ? {} : { c: opts.c }) } }),
  };
  return { ...frame, t: String(frame['t']) };
}

/** Stored frames of `sid` for seqs `from`..`to`. */
export function storedRange(sid: string, from: number, to: number): StoredFrame[] {
  const out: StoredFrame[] = [];
  for (let seq = from; seq <= to; seq++) {
    const converted = toStoredFrame(sequenced(sid, seq));
    if (!converted.ok) throw new Error('fixture frame refused');
    out.push(converted.frame);
  }
  return out;
}

/** A HistoryAccess the test scripts: standings by `sid:user`. */
export function scriptedAccess() {
  const standings = new Map<string, SessionStanding>();
  const sessions = new Set<string>();
  const access: HistoryAccess = {
    standing(sid, caller) {
      if (!sessions.has(sid)) return Promise.resolve(null);
      return Promise.resolve(
        standings.get(`${sid}:${caller.userId}`) ?? {
          workspaceId: null,
          role: null,
          workspaceOwner: false,
          shareLinkGuest: false,
          shareHistory: true,
        },
      );
    },
  };
  const set = (sid: string, userId: string, standing: Partial<SessionStanding>): void => {
    sessions.add(sid);
    standings.set(`${sid}:${userId}`, {
      workspaceId: null,
      role: null,
      workspaceOwner: false,
      shareLinkGuest: false,
      shareHistory: true,
      ...standing,
    });
  };
  return { access, set, sessions };
}

/** A HistoryStore in memory with the real one's read rules. */
export function memoryHistoryStore(): HistoryStore & {
  frames: Map<string, Map<number, StoredFrame>>;
  failReads: boolean;
  failPurge: boolean;
} {
  const frames = new Map<string, Map<number, StoredFrame>>();
  const store = {
    frames,
    failReads: false,
    failPurge: false,
    append(sid: string, list: readonly StoredFrame[]) {
      const of = frames.get(sid) ?? new Map<number, StoredFrame>();
      frames.set(sid, of);
      for (const f of list) if (!of.has(f.seq)) of.set(f.seq, { ...f, size: 1 });
      return Promise.resolve({ lastSeq: Math.max(0, ...list.map((f) => f.seq)) });
    },
    read(sid: string, afterSeq: number, limit: number): Promise<HistoryRead> {
      if (store.failReads) return Promise.reject(new Error('blob down'));
      const of = frames.get(sid) ?? new Map<number, StoredFrame>();
      const seqs = [...of.keys()].sort((a, b) => a - b);
      const earliest = seqs[0] ?? null;
      const head = seqs.at(-1) ?? null;
      if (earliest === null)
        return Promise.resolve({
          frames: [],
          nextAfterSeq: null,
          earliestSeq: null,
          headSeq: null,
        });
      const start = Math.max(afterSeq + 1, earliest);
      const run: StoredFrame[] = [];
      for (let s = start; of.has(s) && run.length <= limit; s++) run.push(of.get(s) as StoredFrame);
      const page = run.slice(0, limit);
      return Promise.resolve({
        frames: page,
        nextAfterSeq: run.length > limit ? (page.at(-1)?.seq ?? null) : null,
        earliestSeq: earliest,
        headSeq: head,
      });
    },
    purge(sid: string) {
      if (store.failPurge) return Promise.reject(new Error('blob down'));
      const n = frames.get(sid)?.size ?? 0;
      frames.delete(sid);
      return Promise.resolve({ deleted: n, blobs: n === 0 ? 0 : 1 });
    },
    setExpiry() {
      return Promise.resolve();
    },
  };
  return store;
}

/** The history API over `store` and `access`, with the in-memory token service. */
export async function historyApp(
  store: HistoryStore = memoryHistoryStore(),
  access: HistoryAccess = scriptedAccess().access,
) {
  const captured = captureLogger();
  const { tokens, store: refresh } = memoryTokens();
  const audited: AuditEvent[] = [];
  const service = new HistoryService({
    store,
    access,
    audit: { emitDetached: (e) => void audited.push(e) },
    logger: captured.logger,
  });
  tokens.registerPrincipalResolver('cen_', () =>
    Promise.resolve({
      kind: 'api_key',
      userId: null,
      deviceId: null,
      workspaceId: newId('wsp'),
      scopes: ['sessions:read', 'sessions:host'],
    }),
  );
  const app: FastifyInstance = fastify({
    logger: false,
    frameworkErrors: frameworkErrorHandler({ logger: captured.logger }),
  });
  await app.register(requestContextPlugin, { logger: captured.logger });
  await app.register(errorHandlerPlugin, { logger: captured.logger });
  await app.register(authPlugin, { tokens });
  await app.register(historyRoutes, { service, cursorKeys: KEYS });
  await app.ready();
  /** A bearer header for `userId` with `scopes`. */
  const bearerOf = async (
    userId: string,
    scopes: string[] = ['sessions:read', 'sessions:host'],
  ): Promise<Record<string, string>> => {
    const deviceId = newId('dev');
    refresh.devices.set(deviceId, { userId, revoked: false });
    const t = await tokens.issueTokens({ userId, deviceId, scopes });
    return { authorization: `Bearer ${t.access_token}` };
  };
  return { app, service, audited, captured, bearerOf };
}
