/**
 * Metrics (B037, card test relay.metrics.test.ts, acceptance 7; names from B093's catalogue):
 * `relay_connections`, `relay_connections_total`, `relay_frames_total{t,direction}` and
 * `relay_close_total{code}` exist and
 * move during a 100-connection run; every label comes from a small fixed set, never a session,
 * member or user id, whatever the frames carry.
 */
import { describe, expect, it } from 'vitest';
import { closeLabel, FRAME_TYPES, frameLabel, RELAY_METRICS } from '../src/index.js';
import { connect, testRelay, until } from './helpers.js';

const SES = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const MEM = 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

describe('relay metrics over 100 connections (acceptance 7)', () => {
  it('counts connections, frames by type and closes by code, with bounded labels', async () => {
    const relay = await testRelay();
    try {
      const clients = Array.from({ length: 100 }, () => connect(relay.url));
      await Promise.all(clients.map((c) => c.opened));
      await until(() => relay.registry.size === 100);
      expect(relay.server.gauges()).toEqual({ [RELAY_METRICS.connectionsActive]: 100 });
      expect(relay.recorded.count(RELAY_METRICS.connectionsTotal)).toBe(100);

      for (const [i, c] of clients.entries()) {
        c.ws.send(JSON.stringify({ v: 1, t: 'event', sid: SES, from: MEM, k: 'message.user' }));
        c.ws.send(JSON.stringify({ v: 1, t: `t_${SES}_${i}` }));
        c.ws.send('not json');
        c.ws.send(Buffer.from([1, 2, 3]));
      }
      const frames = (t: string) =>
        relay.recorded.count(RELAY_METRICS.framesIn, { t, direction: 'in' });
      await until(() => frames('binary') === 100);
      expect(frames('event')).toBe(100);
      expect(frames('invalid')).toBe(200);

      for (const [i, c] of clients.entries()) {
        if (i % 2 === 0) c.ws.close(1000);
        else c.ws.close(4000 + (i % 7));
      }
      await Promise.all(clients.map((c) => c.closed));
      await until(() => relay.registry.size === 0);
      expect(relay.server.gauges()).toEqual({ [RELAY_METRICS.connectionsActive]: 0 });
      expect(relay.recorded.count(RELAY_METRICS.closes, { code: '1000' })).toBe(50);
      expect(relay.recorded.count(RELAY_METRICS.closes, { code: 'other' })).toBe(50);

      const series = relay.recorded.series();
      const names = new Set(series.map((s) => s.name));
      for (const name of [
        RELAY_METRICS.connectionsTotal,
        RELAY_METRICS.framesIn,
        RELAY_METRICS.closes,
      ]) {
        expect(names.has(name)).toBe(true);
      }
      const allowed: Record<string, readonly string[]> = {
        t: [...FRAME_TYPES, 'invalid', 'binary'],
        direction: ['in'],
        code: [
          '1000',
          '1001',
          '1005',
          '1006',
          '1011',
          '4400',
          '4401',
          '4403',
          '4404',
          '4408',
          '4409',
          '4426',
          '4429',
          '4503',
          'other',
        ],
        reason: ['path', 'query_credentials', 'origin', 'subprotocol', 'draining', 'bad_request'],
      };
      for (const { labels } of series) {
        for (const [key, value] of Object.entries(labels)) {
          expect(allowed[key], `label ${key}`).toBeDefined();
          expect(allowed[key]).toContain(value);
          expect(value).not.toMatch(/(ses|mem|usr)_/);
        }
      }
    } finally {
      await relay.stop();
    }
  }, 30_000);
});

describe('labels', () => {
  it('names a frame by its envelope type only', () => {
    expect(frameLabel(JSON.stringify({ t: 'sys.hello' }))).toBe('sys.hello');
    expect(frameLabel(JSON.stringify({ t: 'presence', sid: SES }))).toBe('presence');
    expect(frameLabel(JSON.stringify({ t: SES }))).toBe('invalid');
    expect(frameLabel(JSON.stringify({ t: 7 }))).toBe('invalid');
    expect(frameLabel('null')).toBe('invalid');
    expect(frameLabel('[')).toBe('invalid');
    expect(frameLabel(null)).toBe('binary');
  });

  it('names a close by a known code or other', () => {
    expect(closeLabel(1001)).toBe('1001');
    expect(closeLabel(1006)).toBe('1006');
    expect(closeLabel(4503)).toBe('4503');
    expect(closeLabel(4999)).toBe('other');
    expect(closeLabel(3000)).toBe('other');
  });
});
