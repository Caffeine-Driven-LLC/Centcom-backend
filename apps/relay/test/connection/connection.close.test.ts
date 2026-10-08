/**
 * closeConnection (B040, CT-WS-ENVELOPE "Close codes"):
 *
 * - each close path sends its frame first: 4400/4401/4403/4404/4408/4426/4429/4503/1011 a
 *   `sys.error` that is a valid CT-ERR problem, 4409 (superseded) and 1001 (going away) a `sys.bye`;
 * - a spec without the frame its code needs is refused (a programming error);
 * - calling it twice sends one frame and one close;
 * - a socket that does not finish closing is cut after 1 s, and the fallback timer goes once the
 *   socket closes;
 * - the error-to-close table maps every listed CT-ERR code to the contract's close code;
 * - on a real relay, a connection closed twice leaves the registry exactly once.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { validateEnvelope, validateProblem } from '@centcom/contracts';
import { ERROR_CODES, type ErrorCode } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { CloseCode, type CloseCodeValue } from '../../src/close-codes.js';
import {
  CLOSE_FRAMES,
  CLOSE_TERMINATE_MS,
  closeCodeFor,
  closeConnection,
  CloseSpecError,
  ERROR_CLOSE,
  type CloseSpec,
} from '../../src/connection/close.js';
import { fakeConnection, liveRelay, manualTimers, until } from './helpers.js';

/** A valid spec for each close code. */
const SPECS: Record<CloseCodeValue, CloseSpec> = {
  [CloseCode.Normal]: { code: CloseCode.Normal },
  [CloseCode.GoingAway]: { code: CloseCode.GoingAway, bye: 'server_restart' },
  [CloseCode.InternalError]: { code: CloseCode.InternalError, errorCode: 'internal_error' },
  [CloseCode.ProtocolViolation]: { code: CloseCode.ProtocolViolation, errorCode: 'invalid_frame' },
  [CloseCode.Unauthenticated]: { code: CloseCode.Unauthenticated, errorCode: 'ticket_invalid' },
  [CloseCode.Forbidden]: { code: CloseCode.Forbidden, errorCode: 'not_a_member' },
  [CloseCode.NotFound]: { code: CloseCode.NotFound, errorCode: 'session_not_found' },
  [CloseCode.HandshakeTimeout]: {
    code: CloseCode.HandshakeTimeout,
    errorCode: 'protocol_violation',
  },
  [CloseCode.Superseded]: { code: CloseCode.Superseded, bye: 'superseded' },
  [CloseCode.ClientTooOld]: {
    code: CloseCode.ClientTooOld,
    errorCode: 'client_too_old',
    extra: { upgrade: { protocols: [1], min_version: '1.0.0' } },
  },
  [CloseCode.RateLimited]: { code: CloseCode.RateLimited, errorCode: 'slow_consumer' },
  [CloseCode.Overloaded]: {
    code: CloseCode.Overloaded,
    errorCode: 'service_unavailable',
    retryAfterS: 5,
  },
};

const codes = Object.values(CloseCode);

describe('the frame before each close', () => {
  it('has a rule for every close code in the table', () => {
    expect(Object.keys(CLOSE_FRAMES).map(Number).sort()).toEqual([...codes].sort());
  });

  it.each(codes)('close %i is preceded by its frame, then closed', (code) => {
    const fake = fakeConnection();
    expect(closeConnection(fake.connection, SPECS[code])).toBe(true);
    const frame = CLOSE_FRAMES[code];
    if (frame === 'none') {
      expect(fake.events).toEqual([{ kind: 'close', code, reason: '', at: 0 }]);
      return;
    }
    const [first, second] = fake.events;
    expect(second).toMatchObject({ kind: 'close', code });
    expect(first?.kind).toBe('send');
    const sent = first?.kind === 'send' ? first.frame : {};
    expect(validateEnvelope(sent).ok).toBe(true);
    if (frame === 'error') {
      expect(sent['t']).toBe('sys.error');
      const problem = sent['p'] as Record<string, unknown>;
      expect(validateProblem(problem).ok, JSON.stringify(problem)).toBe(true);
      expect(problem['code']).toBe(SPECS[code].errorCode);
    } else {
      expect(sent).toEqual({ v: 1, t: 'sys.bye', p: { reason: SPECS[code].bye } });
    }
  });

  it("gives the card's codes a sys.error (4401, 4403, 4404, 4426, 4429) and the goodbyes a sys.bye", () => {
    for (const code of [4401, 4403, 4404, 4426, 4429] as const)
      expect(CLOSE_FRAMES[code]).toBe('error');
    expect(CLOSE_FRAMES[CloseCode.Superseded]).toBe('bye');
    expect(CLOSE_FRAMES[CloseCode.GoingAway]).toBe('bye');
  });

  it('carries retry_after_s, detail, errors and extra members into the problem', () => {
    const fake = fakeConnection();
    closeConnection(fake.connection, {
      code: CloseCode.ProtocolViolation,
      errorCode: 'invalid_frame',
      detail: 'Not a frame.',
      errors: [{ pointer: '/t', code: 'invalid', detail: 'is not valid here' }],
    });
    closeConnection(fakeConnection().connection, SPECS[CloseCode.Overloaded]);
    const p = fake.sent()[0]?.['p'] as Record<string, unknown>;
    expect(p).toMatchObject({ code: 'invalid_frame', detail: 'Not a frame.' });
    expect(p['errors']).toEqual([{ pointer: '/t', code: 'invalid', detail: 'is not valid here' }]);
    const overloaded = fakeConnection();
    closeConnection(overloaded.connection, SPECS[CloseCode.Overloaded]);
    expect(overloaded.sent()[0]?.['p']).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: 5,
    });
    const tooOld = fakeConnection();
    closeConnection(tooOld.connection, SPECS[CloseCode.ClientTooOld]);
    expect(tooOld.sent()[0]?.['p']).toMatchObject({ upgrade: { min_version: '1.0.0' } });
  });

  it.each([
    [{ code: CloseCode.Unauthenticated }, /must be preceded by a sys.error/],
    [{ code: CloseCode.Superseded }, /must be preceded by a sys.bye/],
    [{ code: CloseCode.GoingAway, bye: '' }, /must be preceded by a sys.bye/],
    [{ code: CloseCode.Superseded, errorCode: 'forbidden' }, /must be preceded by a sys.bye/],
    [{ code: CloseCode.Superseded, errorCode: 'forbidden', bye: 'superseded' }, /not both/],
    [{ code: CloseCode.Normal, errorCode: 'forbidden' }, /not preceded by a sys.error/],
    [{ code: CloseCode.Forbidden, errorCode: 'forbidden', bye: 'x' }, /not both/],
    [{ code: 4999 as CloseCodeValue }, /not a close code/],
  ] as [CloseSpec, RegExp][])('refuses %j', (spec, message) => {
    const fake = fakeConnection();
    expect(() => closeConnection(fake.connection, spec)).toThrow(CloseSpecError);
    expect(() => closeConnection(fake.connection, spec)).toThrow(message);
    expect(fake.events).toEqual([]);
  });
});

describe('closing once', () => {
  it('sends one frame and one close when called twice', () => {
    const fake = fakeConnection();
    expect(closeConnection(fake.connection, SPECS[CloseCode.Superseded])).toBe(true);
    expect(closeConnection(fake.connection, SPECS[CloseCode.Superseded])).toBe(false);
    expect(closeConnection(fake.connection, SPECS[CloseCode.Forbidden])).toBe(false);
    expect(fake.events.map((e) => e.kind)).toEqual(['send', 'close']);
  });

  it('cuts a socket that has not closed 1 s later, and drops the timer once it closes', () => {
    const timers = manualTimers();
    const stuck = fakeConnection();
    closeConnection(stuck.connection, SPECS[CloseCode.Normal], { setTimer: timers.setTimer });
    expect(timers.armed()).toBe(1);
    timers.clock.advance(CLOSE_TERMINATE_MS - 1);
    expect(stuck.events.at(-1)?.kind).toBe('close');
    timers.clock.advance(1);
    expect(stuck.events.at(-1)?.kind).toBe('terminate');
    expect(timers.armed()).toBe(0);

    const prompt = fakeConnection();
    closeConnection(prompt.connection, SPECS[CloseCode.Normal], { setTimer: timers.setTimer });
    prompt.closeSocket();
    expect(timers.armed()).toBe(0);
    timers.clock.advance(CLOSE_TERMINATE_MS * 2);
    expect(prompt.events.map((e) => e.kind)).toEqual(['close']);
  });
});

describe('the error-to-close table', () => {
  it('maps connection-ending errors to the contract codes', () => {
    const expected: Record<number, ErrorCode[]> = {
      4400: ['invalid_frame', 'frame_too_large', 'protocol_violation'],
      4401: [
        'unauthorized',
        'token_expired',
        'token_invalid',
        'token_revoked',
        'ticket_invalid',
        'ticket_replayed',
        'device_revoked',
      ],
      4403: ['forbidden', 'not_a_member', 'entitlement_required', 'access_denied', 'session_full'],
      4404: ['session_not_found', 'session_ended'],
      4426: ['client_too_old'],
      4429: ['rate_limited', 'frame_rate_exceeded', 'slow_consumer'],
      4503: ['service_unavailable'],
      1011: ['internal_error'],
    };
    for (const [code, errors] of Object.entries(expected)) {
      for (const error of errors) expect(closeCodeFor(error), error).toBe(Number(code));
    }
    expect(Object.keys(ERROR_CLOSE)).toHaveLength(Object.values(expected).flat().length);
    for (const error of Object.keys(ERROR_CLOSE)) expect(ERROR_CODES).toContain(error);
    expect(closeCodeFor('workspace_not_found')).toBeUndefined();
  });

  it('pairs every mapped error with the frame its code needs', () => {
    for (const [error, code] of Object.entries(ERROR_CLOSE)) {
      expect(CLOSE_FRAMES[code as CloseCodeValue], error).toBe('error');
    }
  });
});

describe('on a running relay', () => {
  it('a connection closed twice gets one frame and one close, and leaves the registry exactly once', async () => {
    const live = await liveRelay();
    const removed: boolean[] = [];
    const remove = live.relay.registry.remove.bind(live.relay.registry);
    live.relay.registry.remove = (id: string) => {
      const r = remove(id);
      removed.push(r);
      return r;
    };
    try {
      const client = await live.client();
      const [connection] = live.relay.server.connections();
      if (connection === undefined) throw new Error('no connection');
      expect(closeConnection(connection, SPECS[CloseCode.Superseded])).toBe(true);
      expect(closeConnection(connection, SPECS[CloseCode.Superseded])).toBe(false);
      const info = await client.waitForClose();
      expect(info).toEqual({ code: 4409, reason: 'superseded' });
      await until(() => live.relay.registry.size === 0, 3_000);
      expect(removed.filter(Boolean)).toHaveLength(1);
      expect(client.wire.filter((f) => f.t === 'sys.bye')).toHaveLength(1);
      expect(live.heartbeat.size).toBe(0);
    } finally {
      await live.stop();
    }
  });
});

describe('every close path', () => {
  it('goes through closeConnection: no module closes a connection directly', () => {
    const src = join(import.meta.dirname, '../../src');
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(src, f));
    const direct: string[] = [];
    for (const file of files) {
      const name = relative(src, file).split(sep).join('/');
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!/\.close\(\s*(?:CloseCode\.|\d|code\b|refusal)/.test(line)) return;
          // closeConnection itself, the socket under a RelayConnection, and a socket refused
          // before it became one (4503 past the cap).
          const allowed =
            name === 'connection/close.ts' ||
            (name === 'server.ts' && /(?:this\.ws|ws)\.close\(/.test(line));
          if (!allowed) direct.push(`${name}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(direct).toEqual([]);
  });
});
