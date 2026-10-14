/**
 * The credential-leak guard (B101) on the relay's frame pipeline, mounted as a module of order 31: a frame whose
 * clear parts hold a provider credential is answered `sys.error invalid_frame` (one body for every pattern,
 * without the text) and goes no further; ciphertext (`ct`) and its signature are never read, so a credential-
 * shaped string there passes untouched; a clean frame passes; the module is found and ordered after the privacy
 * gate; the relay's own log lines are redacted. Each test fails if the module is removed.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import { FramePipeline, STAGE_ORDER } from '../../src/pipeline.js';
import relayModule, {
  SECRET_GUARD_DETAIL,
  secretGuardStage,
} from '../../src/secret-guard/module.js';
import { textConnection } from '../fanout/helpers.js';
import { recordingMetrics } from '../helpers.js';

const ANTHROPIC = ['sk', 'ant', 'api03', 'Zq8WmN3xK7vB2cT5yH9jL4pR6'].join('-');
const AWS = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');

function setup() {
  const recorded = recordingMetrics();
  const conn = textConnection(new ConnectionRegistry({ max: 10 }), newId('ses'));
  const pipeline = new FramePipeline();
  relayModule.register({ pipeline, metrics: recorded.metrics, log: { warn() {} } } as never);
  const run = async (frame: Record<string, unknown>): Promise<boolean> => {
    let reached = false;
    pipeline.use(999, (_fc, next) => {
      reached = true;
      return next();
    });
    await pipeline.run({ connection: conn, raw: '', frame, state: {} });
    return reached;
  };
  return { recorded, conn, run, pipeline };
}

const frame = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  t: 'event',
  id: newId('msg'),
  k: 'message.user',
  ts: new Date().toISOString(),
  ...extra,
});

describe('the frame guard', () => {
  it('stops a frame whose clear payload holds a credential, answering invalid_frame with one body for every pattern', async () => {
    const bodies: string[] = [];
    for (const key of [ANTHROPIC, AWS]) {
      const t = setup();
      const reached = await t.run(frame({ p: { note: `use ${key}` } }));
      expect(reached).toBe(false);
      const sent = t.conn.frames().at(-1) as {
        t: string;
        ref?: string;
        p: { code: string; detail: string };
      };
      expect(sent.t).toBe('sys.error');
      expect(sent.p.code).toBe('invalid_frame');
      expect(sent.p.detail).toBe(SECRET_GUARD_DETAIL);
      expect(JSON.stringify(sent)).not.toContain(key);
      bodies.push(sent.p.detail);
    }
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('counts the hit by pattern id', async () => {
    const t = setup();
    await t.run(frame({ p: { note: ANTHROPIC } }));
    expect(
      t.recorded.count('secret_guard_hits_total', {
        surface: 'frame',
        pattern: 'anthropic_api_key',
      }),
    ).toBe(1);
  });

  it('never reads ciphertext or its signature: credential-shaped text there passes', async () => {
    const t = setup();
    const reached = await t.run(
      frame({ ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'AAAA', c: ANTHROPIC }, sig: AWS }),
    );
    expect(reached).toBe(true);
    expect(t.conn.frames()).toHaveLength(0);
  });

  it('passes a clean frame, and leaves a connection that has not said hello to the handshake', async () => {
    const t = setup();
    expect(await t.run(frame({ p: { text: 'hello' } }))).toBe(true);
    const stage = secretGuardStage();
    const unwelcomed = { ...t.conn, entry: { ...t.conn.entry, sessionId: null } };
    let passed = false;
    await stage(
      {
        connection: unwelcomed as never,
        raw: '',
        frame: frame({ p: { x: ANTHROPIC } }),
        state: {},
      },
      () => {
        passed = true;
        return Promise.resolve();
      },
    );
    expect(passed).toBe(true);
  });

  it('is a module of order 31, after the privacy gate and before control, queue and sequencing', () => {
    expect(relayModule.name).toBe('secret-guard');
    expect(relayModule.order).toBe(STAGE_ORDER.secretGuard);
    expect(STAGE_ORDER.privacy).toBeLessThan(STAGE_ORDER.secretGuard);
    expect(STAGE_ORDER.secretGuard).toBeLessThan(STAGE_ORDER.control);
    expect(STAGE_ORDER.secretGuard).toBeLessThan(STAGE_ORDER.sequence);
  });
});
