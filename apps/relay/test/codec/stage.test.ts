/**
 * The decode stage over a socket (B039 acceptance 1, 5 and 6, failure modes): a valid frame
 * reaches the next stages decoded, without server-set fields; an invalid one gets `sys.error`
 * (`invalid_frame` with its pointer, or `frame_too_large`) and goes nowhere; the 11th invalid frame
 * within 60 s closes 4400 while 10 spread over 61 s do not; a binary frame closes 4400; before the
 * handshake authenticates a connection only the transport limits apply; a decoder that throws
 * drops the frame and keeps the connection; the module registers at order 10.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import relayModule from '../../src/codec/module.js';
import { createCodecStage } from '../../src/codec/stage.js';
import { ConnectionRegistry } from '../../src/connection-registry.js';
import type { RelayConnection } from '../../src/pipeline.js';
import { connect, recordingMetrics, testRelay, until } from '../helpers.js';
import { codecRelay, FIXTURE_SID, frameOfBytes } from './helpers.js';

const ping = { v: 1, t: 'sys.ping', p: { t: 1 } };

describe('the decode stage', () => {
  it('passes a valid frame on decoded, without server-set fields', async () => {
    const { relay, passed, open } = await codecRelay();
    try {
      const c = open();
      await c.opened;
      c.ws.send(
        JSON.stringify({ ...ping, from: 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W', seq: 9, extra: 1 }),
      );
      await until(() => passed.length === 1);
      expect(passed).toEqual([ping]);
      expect(c.messages).toEqual([]);
    } finally {
      await relay.stop();
    }
  });

  it('answers an invalid frame with sys.error and its pointer, and routes nothing', async () => {
    const { relay, passed, open } = await codecRelay();
    try {
      const c = open();
      await c.opened;
      c.ws.send(frameOfBytes(400, 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4X'));
      c.ws.send(frameOfBytes(262_145));
      await until(() => c.messages.length === 2);
      const [wrongSession, tooLarge] = c.messages;
      expect(validate('envelope', wrongSession).ok).toBe(true);
      expect(wrongSession?.['p']).toMatchObject({
        code: 'invalid_frame',
        status: 400,
        errors: [{ pointer: '/sid' }],
      });
      expect(tooLarge?.['p']).toMatchObject({ code: 'frame_too_large', status: 413 });
      expect(passed).toEqual([]);
      expect(c.ws.readyState).toBe(c.ws.OPEN);
    } finally {
      await relay.stop();
    }
  });

  it('closes 4400 on a binary frame', async () => {
    const { relay, open } = await codecRelay();
    try {
      const c = open();
      await c.opened;
      c.ws.send(Buffer.from([1, 2, 3]));
      expect((await c.closed).code).toBe(4400);
      expect(c.messages[0]?.['p']).toMatchObject({ code: 'invalid_frame' });
    } finally {
      await relay.stop();
    }
  });

  it('applies only the transport limits before the handshake authenticates', async () => {
    const relay = await testRelay({ modules: [relayModule] });
    try {
      const c = connect(relay.url);
      await c.opened;
      c.ws.send('{"not":"an envelope"');
      c.ws.send(frameOfBytes(262_145));
      await until(() => c.messages.length === 1);
      expect(c.messages[0]?.['p']).toMatchObject({ code: 'frame_too_large' });
      expect(relay.log.lines().find((l) => l['msg'] === 'relay.module_registered')).toMatchObject({
        module: 'codec',
        order: 10,
      });
    } finally {
      await relay.stop();
    }
  });
});

describe('the invalid-frame budget', () => {
  function driven(now: { t: number }) {
    const registry = new ConnectionRegistry({ max: 10 });
    const entry = registry.add('127.0.0.1');
    entry.state = 'authenticated';
    entry.sessionId = FIXTURE_SID;
    const closes: number[] = [];
    const sent: unknown[] = [];
    const connection: RelayConnection = {
      entry,
      send: (frame) => {
        sent.push(frame);
        return true;
      },
      close: (code) => {
        closes.push(code);
      },
      terminate: () => undefined,
    };
    const stage = createCodecStage({ clock: () => now.t });
    const invalid = () => stage({ connection, raw: '{', state: {} }, () => Promise.resolve());
    return { closes, sent, invalid };
  }

  it('closes on the 11th invalid frame within 60 s', async () => {
    const now = { t: 0 };
    const { closes, sent, invalid } = driven(now);
    for (let i = 0; i < 10; i += 1) {
      await invalid();
      now.t += 5_000;
    }
    expect(closes).toEqual([]);
    expect(sent).toHaveLength(10);
    await invalid();
    expect(closes).toEqual([4400]);
  });

  it('does not close for 10 invalid frames spread over 61 s, and keeps sliding', async () => {
    const now = { t: 0 };
    const { closes, invalid } = driven(now);
    for (let i = 0; i < 11; i += 1) {
      await invalid();
      now.t += 6_100;
    }
    expect(closes).toEqual([]);
  });
});

describe('a decoder that throws', () => {
  it('drops the frame, counts it, and keeps the connection', async () => {
    const recorded = recordingMetrics();
    const { relay, passed, open } = await codecRelay({
      metrics: recorded.metrics,
      decode: () => {
        throw new Error('validator bug');
      },
    });
    try {
      const c = open();
      await c.opened;
      c.ws.send(JSON.stringify(ping));
      await until(() => recorded.count('relay_codec_errors_total') === 1);
      expect(passed).toEqual([]);
      expect(c.ws.readyState).toBe(c.ws.OPEN);
    } finally {
      await relay.stop();
    }
  });
});
