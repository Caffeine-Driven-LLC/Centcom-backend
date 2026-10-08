/**
 * Relay tickets for tests (B011): `mintTestTicket()` signs a relay ticket the way the API's
 * join-token endpoint will (CT-AUTH: a JWT signed EdDSA/Ed25519, `aud` `centcom-relay`, 60 s,
 * single-use `jti`, claims `sid`, `mid`, `role`, `dev`, `caps`) with a key pair made for this
 * process, and `testJwks()` publishes the public half for the relay under test. The loopback relay
 * checks tickets with `verifyTestTicket()`.
 *
 * Owns: the test signing key. Must not: hand out the private key, or sign under a key id without
 * the `test-` prefix, so these tickets can never validate against a production JWKS.
 */
import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

/** The ticket audience (CT-AUTH). */
export const TICKET_AUDIENCE = 'centcom-relay';
/** The issuer the API signs as. */
export const TICKET_ISSUER = 'https://api.centcom.dev';
/** Ticket lifetime (CT-AUTH: 60 s). */
export const TICKET_TTL_S = 60;
/** Every test key id starts with this. */
export const TEST_KID_PREFIX = 'test-';

/** Session roles (CT-RBAC). */
export type SessionRole = 'host' | 'editor' | 'viewer';
const ROLES: ReadonlySet<string> = new Set<SessionRole>(['host', 'editor', 'viewer']);

/** The claims of a relay ticket. */
export interface TicketClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  /** Session (`ses_…`). */
  sid: string;
  /** Member (`mem_…`). */
  mid: string;
  role: SessionRole;
  /** Device (`dev_…`); absent for a share-link guest. */
  dev?: string;
  caps: string[];
}

/** A public signing key as the relay reads it from a JWKS. */
export type TestJwk = JsonWebKey & { kid: string; alg: 'EdDSA'; use: 'sig' };

/** A JSON Web Key Set (RFC 7517). */
export interface JsonWebKeySet {
  keys: TestJwk[];
}

/** What to put in a ticket. */
export interface TicketOptions {
  sid: string;
  mid: string;
  role: SessionRole;
  /** The device; omit for a share-link guest. */
  dev?: string;
  /** Lifetime in seconds; default 60. */
  ttlS?: number;
  caps?: string[];
  /** Issue time, epoch ms; default now. */
  now?: number;
  /** Default: 16 random bytes, base64url. */
  jti?: string;
}

interface TestKeyPair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

let keyPair: TestKeyPair | undefined;

/** This process's test key pair, made on first use. */
function testKeyPair(): TestKeyPair {
  if (keyPair === undefined) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    keyPair = { kid: `${TEST_KID_PREFIX}${randomBytes(6).toString('hex')}`, privateKey, publicKey };
  }
  return keyPair;
}

const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A relay ticket signed with the test key. Asynchronous, like fetching one from the API. */
export function mintTestTicket(opts: TicketOptions): Promise<string> {
  const { kid, privateKey } = testKeyPair();
  const iat = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: TicketClaims = {
    iss: TICKET_ISSUER,
    aud: TICKET_AUDIENCE,
    iat,
    exp: iat + (opts.ttlS ?? TICKET_TTL_S),
    jti: opts.jti ?? randomBytes(16).toString('base64url'),
    sid: opts.sid,
    mid: opts.mid,
    role: opts.role,
    ...(opts.dev === undefined ? {} : { dev: opts.dev }),
    caps: opts.caps ?? [],
  };
  const signingInput = `${encodeJson({ alg: 'EdDSA', typ: 'JWT', kid })}.${encodeJson(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return Promise.resolve(`${signingInput}.${signature.toString('base64url')}`);
}

/** The JWKS a relay under test trusts: this process's test public key. */
export function testJwks(): JsonWebKeySet {
  const { kid, publicKey } = testKeyPair();
  return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] };
}

/** Why a ticket was refused. */
export type TicketProblem =
  'malformed' | 'unknown_key' | 'bad_signature' | 'wrong_audience' | 'expired' | 'bad_claims';

/** The verdict on a ticket. */
export type TicketCheck =
  { ok: true; claims: TicketClaims } | { ok: false; problem: TicketProblem };

const decodeJson = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads a ticket's claims without checking it (what a client may look at). */
export function decodeTicket(ticket: string): Partial<TicketClaims> {
  try {
    const payload = decodeJson(ticket.split('.')[1] ?? '');
    return isRecord(payload) ? (payload as Partial<TicketClaims>) : {};
  } catch {
    return {};
  }
}

/**
 * Checks a ticket as a relay must (CT-WS-ENVELOPE §Handshake): an EdDSA signature by a `test-` key
 * of `jwks`, the audience, expiry and the claims' shape. Single use (`jti`) is the relay's to track.
 */
export function verifyTestTicket(
  ticket: string,
  opts: { jwks?: JsonWebKeySet; now?: number; audience?: string } = {},
): TicketCheck {
  const parts = ticket.split('.');
  const [headerPart, payloadPart, signaturePart] = parts;
  if (
    parts.length !== 3 ||
    headerPart === undefined ||
    payloadPart === undefined ||
    signaturePart === undefined
  ) {
    return { ok: false, problem: 'malformed' };
  }
  let header: unknown;
  let claims: unknown;
  try {
    header = decodeJson(headerPart);
    claims = decodeJson(payloadPart);
  } catch {
    return { ok: false, problem: 'malformed' };
  }
  if (!isRecord(header) || !isRecord(claims) || header['alg'] !== 'EdDSA')
    return { ok: false, problem: 'malformed' };
  const kid = header['kid'];
  const jwk = (opts.jwks ?? testJwks()).keys.find((key) => key.kid === kid);
  if (typeof kid !== 'string' || !kid.startsWith(TEST_KID_PREFIX) || jwk === undefined) {
    return { ok: false, problem: 'unknown_key' };
  }
  const signed = verify(
    null,
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signaturePart, 'base64url'),
  );
  if (!signed) return { ok: false, problem: 'bad_signature' };
  if (claims['aud'] !== (opts.audience ?? TICKET_AUDIENCE))
    return { ok: false, problem: 'wrong_audience' };
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof claims['exp'] !== 'number' || claims['exp'] <= nowS)
    return { ok: false, problem: 'expired' };
  const { sid, mid, role, jti, dev, caps } = claims;
  if (
    typeof sid !== 'string' ||
    typeof mid !== 'string' ||
    typeof jti !== 'string' ||
    typeof role !== 'string' ||
    !ROLES.has(role) ||
    (dev !== undefined && typeof dev !== 'string') ||
    !Array.isArray(caps)
  ) {
    return { ok: false, problem: 'bad_claims' };
  }
  return { ok: true, claims: claims as unknown as TicketClaims };
}
