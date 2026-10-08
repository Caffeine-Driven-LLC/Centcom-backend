/**
 * Test helpers for the relay handshake (B038): an Ed25519 key served by a stub JWKS fetcher,
 * tickets minted the way the API mints them (B017: EdDSA, `kid`, `typ` JWT, issuer, audience
 * `centcom-relay`, 60 s, `jti`, claims sid/mid/role/dev/caps) with every field overridable, an
 * in-memory `SessionAccess`, and a relay started with the handshake and a recording stage after
 * it (order 50) that sees what the handshake lets through.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createIdGenerator } from '@centcom/contracts';
import { SignJWT, type JWTHeaderParameters } from 'jose';
import type { SessionAccess, SessionAccessResult } from '../../src/handshake/access.js';
import type { HandshakeConfig } from '../../src/handshake/config.js';
import { createHandshake, type HandshakeDeps } from '../../src/handshake/handshake.js';
import { JwksCache, type JwksFetcher } from '../../src/handshake/jwks.js';
import { RELAY_AUDIENCE, TICKET_ISSUER } from '../../src/handshake/ticket.js';
import type { RelayModule } from '../../src/modules.js';
import { connect, testRelay, until, type Client, type TestRelay } from '../helpers.js';

export const newId = createIdGenerator();

/** An Ed25519 key pair and its public JWK. */
export function signingKey(kid = 'k1'): { kid: string; privateKey: KeyObject; jwk: object } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { kty, crv, x } = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, jwk: { kty, crv, kid, x, alg: 'EdDSA', use: 'sig' } };
}

/** A JWKS fetcher serving `state.keys` (which the test may change), counting its calls. */
export function stubJwks(keys: object[]): {
  fetcher: JwksFetcher;
  state: { calls: number; fail: boolean; keys: object[]; delayMs: number };
} {
  const state = { calls: 0, fail: false, keys, delayMs: 0 };
  const fetcher: JwksFetcher = async () => {
    state.calls += 1;
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.fail) throw new Error('connect ECONNREFUSED');
    return { keys: state.keys };
  };
  return { fetcher, state };
}

/** The claims a ticket carries. */
export interface TicketInput {
  sid: string;
  mid: string;
  role: 'host' | 'editor' | 'viewer';
  dev: string;
  caps: string[];
}

/** Fresh ids for a ticket. */
export const ticketFor = (overrides: Partial<TicketInput> = {}): TicketInput => ({
  sid: newId('ses'),
  mid: newId('mem'),
  role: 'editor',
  dev: newId('dev'),
  caps: ['resume'],
  ...overrides,
});

/** A ticket as the API mints it; `opts` bend any part of it. */
export async function mintTicket(
  key: { kid: string; privateKey: KeyObject },
  claims: TicketInput,
  opts: {
    nowMs?: number;
    ttlS?: number;
    iatOffsetS?: number;
    audience?: string;
    issuer?: string;
    typ?: string;
    jti?: string;
    header?: Partial<JWTHeaderParameters>;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const iat = now + (opts.iatOffsetS ?? 0);
  return new SignJWT({ ...claims, ...opts.extra })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: opts.typ ?? 'JWT', ...opts.header })
    .setIssuer(opts.issuer ?? TICKET_ISSUER)
    .setAudience(opts.audience ?? RELAY_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttlS ?? 60))
    .setJti(opts.jti ?? randomBytes(16).toString('base64url'))
    .sign(key.privateKey);
}

/** An in-memory SessionAccess: `records` by `sid:mid:dev`, null for unknown sessions. */
export function memoryAccess(): SessionAccess & {
  records: Map<string, SessionAccessResult>;
  calls: number;
  allow(t: TicketInput, overrides?: Partial<SessionAccessResult>): SessionAccessResult;
} {
  const records = new Map<string, SessionAccessResult>();
  const access = {
    records,
    calls: 0,
    resolve(sid: string, mid: string, dev: string) {
      access.calls += 1;
      return Promise.resolve(records.get(`${sid}:${mid}:${dev}`) ?? null);
    },
    allow(t: TicketInput, overrides: Partial<SessionAccessResult> = {}) {
      const record: SessionAccessResult = {
        session: { state: 'live', maxMembers: 12 },
        member: { id: t.mid, name: 'Alex', slot: 0, role: t.role },
        deviceRevoked: false,
        relayAccess: true,
        rosterV: 3,
        ...overrides,
      };
      records.set(`${t.sid}:${t.mid}:${t.dev}`, record);
      return record;
    },
  };
  return access;
}

/** Handshake settings for tests. */
export const TEST_HANDSHAKE_CONFIG: HandshakeConfig = {
  jwksUrl: 'https://api.centcom.test/.well-known/jwks.json',
  minClientVersion: '1.0.0',
  caps: ['resume', 'cursor.coalesce'],
};

/** A `sys.hello` frame. */
export function hello(ticket: unknown, p: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    t: 'sys.hello',
    p: {
      protocols: [1],
      caps: ['resume'],
      ticket,
      client: { name: 'centcom-cli', version: '1.4.2', contract: '1.0.0' },
      last_seq: null,
      ...p,
    },
  };
}

/** A relay with the handshake (on the given doubles) and a recording stage after it. */
export async function handshakeRelay(
  overrides: Partial<Omit<HandshakeDeps, 'registry' | 'kv'>> = {},
): Promise<{
  relay: TestRelay;
  key: ReturnType<typeof signingKey>;
  jwks: ReturnType<typeof stubJwks>;
  access: ReturnType<typeof memoryAccess>;
  passed: unknown[];
  open(): Client;
  stop(): Promise<void>;
}> {
  const key = signingKey();
  const jwks = stubJwks([key.jwk]);
  const access = memoryAccess();
  const passed: unknown[] = [];
  const module: RelayModule = {
    name: 'handshake',
    order: 15,
    register(ctx) {
      const handshake = createHandshake({
        config: TEST_HANDSHAKE_CONFIG,
        jwks: new JwksCache({ url: TEST_HANDSHAKE_CONFIG.jwksUrl, fetch: jwks.fetcher }),
        kv: ctx.redis.kv,
        access,
        registry: ctx.connections,
        logger: ctx.log,
        metrics: ctx.metrics,
        ...overrides,
      });
      ctx.pipeline.use(15, handshake.stage);
      ctx.pipeline.use(50, async (fc) => {
        passed.push(fc.raw === null ? null : (JSON.parse(fc.raw) as unknown));
      });
      ctx.onConnection(handshake.onConnection);
      return undefined;
    },
  };
  const relay = await testRelay({ modules: [module] });
  return {
    relay,
    key,
    jwks,
    access,
    passed,
    open: () => connect(relay.url),
    stop: () => relay.stop(),
  };
}

/** Sends `frame` once the client is open. */
export async function send(client: Client, frame: unknown): Promise<void> {
  await client.opened;
  client.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
}

/** Waits for the client's first message of type `t`. */
export async function first(client: Client, t: string): Promise<Record<string, unknown>> {
  await until(() => client.messages.some((m) => m['t'] === t), 3_000);
  return client.messages.find((m) => m['t'] === t) as Record<string, unknown>;
}

export { until };
