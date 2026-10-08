/**
 * The relay handshake (B038, CT-WS-ENVELOPE "Handshake"): the pipeline stage at order 15 and the
 * connection handler that together turn an upgraded socket into a session member, or close it.
 *
 * 1. A connection must send `sys.hello` within 5 s, else `sys.error` and close 4408. Its first
 *    frame must be a `sys.hello` (else 4400); malformed JSON is `invalid_frame`, 4400.
 * 2. A hello without a usable ticket is 4401. Otherwise the hello must match the envelope schema
 *    (4400), and protocol and client version must be supported (4426 `client_too_old`, with the
 *    supported protocols and minimum version in `p.upgrade`).
 * 3. The ticket is verified (`verifyRelayTicket`), then consumed: its `jti` is stored with
 *    `SET NX` for 120 s, so a second use is 4401 even after the first connection closed. Every
 *    ticket failure is the same 4401 body (`ticket_invalid`; `ticket_replayed` for a replay).
 * 4. The live records decide (`SessionAccess`, 2 s at most): unknown session 4404
 *    (`session_not_found`), ended or expired 4404 (`session_ended`), membership gone 4403
 *    (`not_a_member`), device revoked 4403 (`forbidden`), no `relay_access` 4403
 *    (`entitlement_required`). Keys, Redis or the records unavailable: 503, close 4503, never an
 *    unchecked ticket.
 * 5. `sys.welcome` goes out with the member's live role (never the ticket's), the negotiated
 *    protocol and capabilities, `roster_v`, heartbeat, server time, limits and session state; the
 *    connection becomes `authenticated` and later frames pass to the next stages. A connection of
 *    the same `(member, device)` already on this node gets `sys.bye` (`superseded`) and close 4409.
 *
 * Nothing but `sys.error` and `sys.welcome` is sent before the welcome; frames that arrive while
 * the hello is being checked are dropped. Logs carry the close code and a reason only, never the
 * ticket or `hello.p`.
 *
 * Owns: the handshake. Must not: authorise from ticket claims, or let a connection through
 * without a consumed ticket.
 */
import { validate } from '@centcom/contracts';
import {
  AppError,
  isAppError,
  noopMetrics,
  unavailable,
  type ErrorCode,
  type KeyValue,
  type Logger,
  type Metrics,
} from '@centcom/core';
import { CloseCode, type CloseCodeValue } from '../close-codes.js';
import type { ConnectionEntry, ConnectionRegistry } from '../connection-registry.js';
import type { FrameContext, InboundStage, RelayConnection } from '../pipeline.js';
import { closeConnection } from '../connection/close.js';
import { DEFAULT_DEAD_MS, DEFAULT_PING_MS } from '../connection/config.js';
import type { SessionAccess, SessionAccessResult } from './access.js';
import type { HandshakeConfig } from './config.js';
import type { JwksCache } from './jwks.js';
import { negotiate, SERVER_PROTOCOLS, type Hello } from './negotiate.js';
import { TicketError, verifyRelayTicket, type TicketClaims } from './ticket.js';

/** A client has this long after the upgrade to send `sys.hello`. */
export const HELLO_TIMEOUT_MS = 5_000;
/** How long a used ticket's `jti` is remembered (tickets live 60 s, plus skew). */
export const JTI_TTL_MS = 120_000;
/** The longest wait for the live records. */
export const ACCESS_TIMEOUT_MS = 2_000;
/** CT-WS-ENVELOPE heartbeat defaults; a relay advertises its configured values (B040). */
export const HEARTBEAT = Object.freeze({ ping_ms: DEFAULT_PING_MS, dead_ms: DEFAULT_DEAD_MS });
/** CT-WS-ENVELOPE limits (defaults); `max_members` comes from the session's plan. */
export const WELCOME_LIMITS = Object.freeze({
  max_frame_bytes: 262_144,
  seq_rate: 30,
  seq_burst: 100,
  presence_rate: 10,
  outbound_buffer_bytes: 2_097_152,
});
/** Members per session, whatever the plan (CT-WS-ENVELOPE). */
export const MAX_MEMBERS_CAP = 50;

/** Why a handshake ended without a welcome (logs and metrics). */
export type HandshakeRefusal =
  | 'timeout'
  | 'not_hello'
  | 'invalid_frame'
  | 'ticket'
  | 'replay'
  | 'too_old'
  | 'session_unknown'
  | 'session_ended'
  | 'membership'
  | 'device'
  | 'entitlement'
  | 'unavailable';

/** A timer that can be cancelled. */
export interface Timer {
  cancel(): void;
}

/** Dependencies of the handshake. */
export interface HandshakeDeps {
  config: HandshakeConfig;
  jwks: Pick<JwksCache, 'key'>;
  /** Where used tickets are remembered (B009 KV: `setIfAbsent` is atomic). */
  kv: KeyValue;
  access: SessionAccess;
  /** To tell an open connection from a closed one. */
  registry: Pick<ConnectionRegistry, 'get'>;
  logger?: Logger;
  metrics?: Metrics;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  /** Runs `fn` after `ms`; default an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => Timer;
  /**
   * The heartbeat `sys.welcome` advertises: the values the connection module enforces
   * (RELAY_PING_MS, RELAY_DEAD_MS, B040); default HEARTBEAT.
   */
  heartbeat?: { ping_ms: number; dead_ms: number };
}

type Phase =
  { phase: 'hello'; timer: Timer } | { phase: 'verifying' } | { phase: 'active'; key: string };

const defaultTimer = (fn: () => void, ms: number): Timer => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A refusal: what the client is told, how the socket closes, and the reason logged. */
class Refusal extends Error {
  constructor(
    readonly close: CloseCodeValue,
    readonly reason: HandshakeRefusal,
    readonly error: AppError,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(reason);
  }
}

const refuse = (
  close: CloseCodeValue,
  reason: HandshakeRefusal,
  code: ErrorCode,
  detail: string,
  extra?: Record<string, unknown>,
): Refusal => new Refusal(close, reason, new AppError(code, { detail }), extra);

/** The uniform 4401 for any ticket that does not verify. */
const badTicket = (): Refusal =>
  refuse(CloseCode.Unauthenticated, 'ticket', 'ticket_invalid', 'The relay ticket is not valid.');

/** A dependency is down: 503 and 4503, `retry_after_s` from the error when it has one. */
const unavailableRefusal = (err: unknown): Refusal =>
  new Refusal(
    CloseCode.Overloaded,
    'unavailable',
    isAppError(err) && err.status === 503
      ? err
      : unavailable(5, 'The relay cannot check tickets right now; try again shortly.'),
  );

/** `sys.welcome` for an accepted hello. */
export function welcomeFrame(input: {
  protocol: number;
  caps: readonly string[];
  access: SessionAccessResult & { member: NonNullable<SessionAccessResult['member']> };
  nowMs: number;
  /** Default HEARTBEAT. */
  heartbeat?: { ping_ms: number; dead_ms: number };
}): object {
  const { access } = input;
  return {
    v: 1,
    t: 'sys.welcome',
    p: {
      protocol: input.protocol,
      caps: [...input.caps],
      member: {
        id: access.member.id,
        name: access.member.name,
        slot: access.member.slot,
        role: access.member.role,
      },
      roster_v: access.rosterV ?? 0,
      heartbeat: { ...(input.heartbeat ?? HEARTBEAT) },
      server_time: new Date(input.nowMs).toISOString(),
      limits: {
        ...WELCOME_LIMITS,
        max_members: Math.min(access.session.maxMembers, MAX_MEMBERS_CAP),
      },
      session: { state: access.session.state },
      resume: null,
    },
  };
}

/** Runs `promise` for at most `ms`; past that, rejects with a 503. */
function within<T>(
  promise: Promise<T>,
  ms: number,
  setTimer: HandshakeDeps['setTimer'],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = (setTimer ?? defaultTimer)(
      () =>
        reject(unavailable(undefined, undefined, { cause: new Error('session access timed out') })),
      ms,
    );
    promise.then(
      (value) => {
        timer.cancel();
        resolve(value);
      },
      (err: unknown) => {
        timer.cancel();
        reject(err instanceof Error ? err : new Error('session access failed'));
      },
    );
  });
}

/** The handshake's stage and connection handler. */
export function createHandshake(deps: HandshakeDeps): {
  stage: InboundStage;
  onConnection: (connection: RelayConnection) => void;
} {
  const clock = deps.clock ?? Date.now;
  const setTimer = deps.setTimer ?? defaultTimer;
  const metrics = deps.metrics ?? noopMetrics;
  const phases = new WeakMap<ConnectionEntry, Phase>();
  /** The live connection of each `(member, device)` on this node. */
  const active = new Map<string, RelayConnection>();

  const isOpen = (connection: RelayConnection): boolean =>
    deps.registry.get(connection.entry.id) !== undefined && connection.entry.state !== 'closing';

  function close(connection: RelayConnection, refusal: Refusal): void {
    metrics.counter('relay_handshakes_total', { outcome: refusal.reason }).inc();
    deps.logger?.info({ close: refusal.close, reason: refusal.reason }, 'relay.handshake_refused');
    if (!isOpen(connection)) return;
    const { error } = refusal;
    closeConnection(connection, {
      code: refusal.close,
      errorCode: error.code,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.retryAfterS === undefined ? {} : { retryAfterS: error.retryAfterS }),
      extra: refusal.extra,
    });
  }

  /** The hello's frame: decoded by an earlier stage, or parsed here. */
  function helloFrame(fc: FrameContext): Record<string, unknown> {
    let frame = fc.frame;
    if (frame === undefined) {
      if (fc.raw === null) {
        throw refuse(
          CloseCode.ProtocolViolation,
          'invalid_frame',
          'invalid_frame',
          'Frames are JSON text.',
        );
      }
      try {
        frame = JSON.parse(fc.raw) as unknown;
      } catch {
        throw refuse(
          CloseCode.ProtocolViolation,
          'invalid_frame',
          'invalid_frame',
          'The frame is not JSON.',
        );
      }
    }
    if (!isRecord(frame) || frame['t'] !== 'sys.hello') {
      throw refuse(
        CloseCode.ProtocolViolation,
        'not_hello',
        'protocol_violation',
        'The first frame must be sys.hello.',
      );
    }
    return frame;
  }

  async function admit(frame: Record<string, unknown>): Promise<{
    claims: TicketClaims;
    access: SessionAccessResult;
    protocol: number;
    caps: string[];
  }> {
    const ticket = isRecord(frame['p']) ? frame['p']['ticket'] : undefined;
    if (typeof ticket !== 'string' || ticket.length < 10) throw badTicket();
    if (!validate('envelope', frame).ok) {
      throw refuse(
        CloseCode.ProtocolViolation,
        'invalid_frame',
        'invalid_frame',
        'sys.hello does not match the envelope schema.',
      );
    }
    const hello = frame['p'] as unknown as Hello;
    const negotiated = negotiate(hello, {
      protocols: SERVER_PROTOCOLS,
      caps: deps.config.caps,
      minClientVersion: deps.config.minClientVersion,
    });
    if (negotiated === 'too_old') {
      throw refuse(
        CloseCode.ClientTooOld,
        'too_old',
        'client_too_old',
        'This client is too old for the relay; update it.',
        {
          upgrade: { protocols: [...SERVER_PROTOCOLS], min_version: deps.config.minClientVersion },
        },
      );
    }

    let claims: TicketClaims;
    try {
      claims = await verifyRelayTicket(ticket, { jwks: deps.jwks, nowMs: clock() });
    } catch (err) {
      if (err instanceof TicketError) throw badTicket();
      throw unavailableRefusal(err);
    }
    let fresh: boolean;
    try {
      fresh = await deps.kv.setIfAbsent(`relay:jti:${claims.jti}`, '1', JTI_TTL_MS);
    } catch (err) {
      throw unavailableRefusal(err);
    }
    if (!fresh) {
      throw refuse(
        CloseCode.Unauthenticated,
        'replay',
        'ticket_replayed',
        'The relay ticket was already used; get a new one.',
      );
    }

    let access: SessionAccessResult | null;
    try {
      access = await within(
        deps.access.resolve(claims.sid, claims.mid, claims.dev),
        ACCESS_TIMEOUT_MS,
        setTimer,
      );
    } catch (err) {
      throw unavailableRefusal(err);
    }
    if (access === null) {
      throw refuse(
        CloseCode.NotFound,
        'session_unknown',
        'session_not_found',
        'There is no such session.',
      );
    }
    if (access.session.state === 'ended' || access.session.state === 'expired') {
      throw refuse(CloseCode.NotFound, 'session_ended', 'session_ended', 'The session has ended.');
    }
    if (access.member === null) {
      throw refuse(
        CloseCode.Forbidden,
        'membership',
        'not_a_member',
        'You are no longer a member of this session.',
      );
    }
    if (access.deviceRevoked) {
      throw refuse(CloseCode.Forbidden, 'device', 'forbidden', 'This device was revoked.');
    }
    if (!access.relayAccess) {
      throw refuse(
        CloseCode.Forbidden,
        'entitlement',
        'entitlement_required',
        "The workspace's plan does not include the relay.",
      );
    }
    return { claims, access, ...negotiated };
  }

  /** Registers the welcomed connection; a previous one of the same `(member, device)` is superseded. */
  function activate(connection: RelayConnection, key: string): void {
    const previous = active.get(key);
    active.set(key, connection);
    phases.set(connection.entry, { phase: 'active', key });
    if (previous !== undefined && previous !== connection && isOpen(previous)) {
      metrics.counter('relay_superseded_total').inc();
      closeConnection(previous, { code: CloseCode.Superseded, bye: 'superseded' });
    }
    // Forget connections that closed since, so the map stays as small as the live set.
    if (active.size > 64) {
      for (const [k, c] of active) {
        if (deps.registry.get(c.entry.id) === undefined) active.delete(k);
      }
    }
  }

  const stage: InboundStage = async (fc, next) => {
    const { connection } = fc;
    const phase = phases.get(connection.entry);
    if (phase?.phase === 'active') {
      await next();
      return;
    }
    if (phase?.phase === 'verifying') {
      metrics.counter('relay_handshake_frames_dropped_total').inc();
      return;
    }
    phase?.timer.cancel();
    phases.set(connection.entry, { phase: 'verifying' });
    try {
      const frame = helloFrame(fc);
      const admitted = await admit(frame);
      if (!isOpen(connection)) return;
      const { access } = admitted;
      if (access.member === null) return;
      connection.send(
        welcomeFrame({
          protocol: admitted.protocol,
          caps: admitted.caps,
          access: { ...access, member: access.member },
          nowMs: clock(),
          ...(deps.heartbeat === undefined ? {} : { heartbeat: deps.heartbeat }),
        }),
      );
      connection.entry.state = 'authenticated';
      connection.entry.sessionId = admitted.claims.sid;
      activate(connection, `${access.member.id}:${admitted.claims.dev}`);
      metrics.counter('relay_handshakes_total', { outcome: 'welcome' }).inc();
    } catch (err) {
      if (err instanceof Refusal) {
        close(connection, err);
        return;
      }
      throw err;
    }
  };

  function onConnection(connection: RelayConnection): void {
    const timer = setTimer(() => {
      if (phases.get(connection.entry)?.phase !== 'hello') return;
      close(
        connection,
        refuse(
          CloseCode.HandshakeTimeout,
          'timeout',
          'protocol_violation',
          `No sys.hello within ${HELLO_TIMEOUT_MS / 1000} s.`,
        ),
      );
    }, HELLO_TIMEOUT_MS);
    phases.set(connection.entry, { phase: 'hello', timer });
  }

  return { stage, onConnection };
}
