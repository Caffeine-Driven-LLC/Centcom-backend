/**
 * Telemetry scrubbing (B085 test plan "unit"): each scrub rule with positive and negative cases,
 * install ids as ULIDs, enum checks against `state-map.json` and the CT-ERR registry, unknown
 * types and fields, batch limits, the hashed per-address key, and the configuration.
 */
import { ERRORS, PRODUCT_STATES } from '@centcom/contracts';
import { Secret } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { loadTelemetryConfig } from '../../src/modules/telemetry/config.js';
import { addressKey } from '../../src/modules/telemetry/limits.js';
import { looksLikePii, scrubBatch, type ScrubResult } from '../../src/modules/telemetry/scrub.js';
import { batch, DAY_MS, event, INSTALL, T0 } from './helpers.js';

const OPTS = { maxEvents: 100, retentionDays: 90, now: new Date(T0) };
const scrub = (events: unknown[], over: Record<string, unknown> = {}) =>
  scrubBatch(batch(events, over), OPTS);
const reasons = (r: ScrubResult) => Object.fromEntries(r.dropped.map((d) => [d.reason, d.count]));

describe('events', () => {
  it('keeps every allow-listed type with its own props', () => {
    const events = [
      event('app.start'),
      event('app.exit'),
      event('command.run', { name: 'session join' }),
      event('session.created', { mode: 'pair', transport: 'relay' }),
      event('session.joined', { transport: 'lan' }),
      event('agent.state_change', { from: 'idle', to: 'thinking' }),
      event('feature.used', { key: 'editor.split_view' }),
      event('error.shown', { code: 'rate_limited' }),
      event('perf.startup', { ms: 812 }),
      event('perf.frame', { p95_ms: 16.4 }),
      event('update.result', { from: '1.3.0', to: '1.4.0-rc.1', ok: true }),
    ];
    const result = scrub(events);
    expect(result.dropped).toEqual([]);
    expect(result.installId).toBe(INSTALL);
    expect(result.accepted).toHaveLength(11);
    expect(result.accepted[2]).toEqual({
      install_id: INSTALL,
      type: 'command.run',
      at: new Date(T0 - 60_000),
      props: { name: 'session join' },
    });
  });

  it('drops command names that look like paths, URLs, e-mails or are too long (pii_pattern)', () => {
    for (const name of [
      'src/index.ts',
      'C:\\Users\\me',
      'me@example.test',
      'https://example.test',
      'file:index',
      'x'.repeat(65),
      'run ~/secrets',
      'Deploy Prod',
      'push origin/main',
      '10.0.0.1',
      'api.example.com',
      'tab\tinside',
    ]) {
      expect(reasons(scrub([event('command.run', { name })])), name).toEqual({ pii_pattern: 1 });
    }
    for (const name of ['login', 'session join', 'agent run', 'queue add-item', 'x'.repeat(32)]) {
      expect(scrub([event('command.run', { name })]).accepted, name).toHaveLength(1);
    }
  });

  it('drops feature keys and modes that are not plain words', () => {
    expect(scrub([event('feature.used', { key: 'editor.split' })]).accepted).toHaveLength(1);
    for (const key of ['feature/login', 'main..x', 'refs.heads', 'repo.git', 'site.io', 'Editor']) {
      expect(reasons(scrub([event('feature.used', { key })])), key).toEqual({ pii_pattern: 1 });
    }
    expect(reasons(scrub([event('session.created', { mode: 'pair mode' })]))).toEqual({
      pii_pattern: 1,
    });
  });

  it('checks states against state-map.json, codes against CT-ERR, transports against relay and lan', () => {
    expect(PRODUCT_STATES).toContain('thinking');
    expect(Object.keys(ERRORS)).toContain('rate_limited');
    expect(reasons(scrub([event('agent.state_change', { from: 'idle', to: 'hacking' })]))).toEqual({
      enum_unknown: 1,
    });
    expect(reasons(scrub([event('error.shown', { code: 'ENOENT' })]))).toEqual({ enum_unknown: 1 });
    expect(reasons(scrub([event('session.joined', { transport: 'carrier-pigeon' })]))).toEqual({
      enum_unknown: 1,
    });
    for (const state of PRODUCT_STATES) {
      expect(
        scrub([event('agent.state_change', { from: state, to: 'idle' })]).accepted,
        state,
      ).toHaveLength(1);
    }
  });

  it('drops wrong types, bad times and too many props (schema), unknown types (type_unknown)', () => {
    const cases: [unknown, string][] = [
      [event('perf.startup', { ms: '812' }), 'schema'],
      [event('perf.startup', { ms: -1 }), 'schema'],
      [event('perf.startup', { ms: 1e12 }), 'schema'],
      [event('update.result', { ok: 'yes' }), 'schema'],
      [event('update.result', { from: '1.3' }), 'schema'],
      [event('app.start', undefined, T0 - 91 * DAY_MS), 'schema'],
      [event('app.start', undefined, T0 + 11 * 60_000), 'schema'],
      [{ type: 'app.start', at: 'yesterday' }, 'schema'],
      [{ type: 'app.start' }, 'schema'],
      [
        event(
          'feature.used',
          Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'x'])),
        ),
        'schema',
      ],
      [event('app.start', ['not', 'an', 'object'] as never), 'schema'],
      ['app.start', 'schema'],
      [event('prompt.sent', { text: 'hello' }), 'type_unknown'],
      [{ at: new Date(T0).toISOString() }, 'type_unknown'],
    ];
    for (const [raw, reason] of cases) {
      expect(reasons(scrub([raw])), JSON.stringify(raw)).toEqual({ [reason]: 1 });
    }
  });

  it('drops unknown props and fields, keeping the event', () => {
    const result = scrub([
      {
        ...event('command.run', { name: 'login', cwd: '/home/me', user: 'usr_x' }),
        ip: '10.0.0.1',
      },
    ]);
    expect(result.accepted).toEqual([expect.objectContaining({ props: { name: 'login' } })]);
    expect(result.fieldsDropped).toBe(3);
    // Top-level fields other than install_id, app and events are dropped too (and never stored).
    const linked = scrub([event('app.start')], { user: 'usr_x', ip: '10.0.0.1' });
    expect(linked.accepted).toHaveLength(1);
    expect(linked.fieldsDropped).toBe(2);
    expect(JSON.stringify(linked.accepted)).not.toMatch(/usr_|10\.0\.0\.1|centcom-cli/);
  });
});

describe('batches', () => {
  it('needs a ULID install id, 1 to 100 events, and an object', () => {
    for (const install_id of [
      '',
      'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
      '01JA3Z8K2M5N7P9Q0R1S2T3V4',
      '81JA3Z8K2M5N7P9Q0R1S2T3V4W',
      '01JA3Z8K2M5N7P9Q0R1S2T3V4I',
      42,
    ]) {
      expect(
        reasons(scrub([event('app.start'), event('app.exit')], { install_id })),
        String(install_id),
      ).toEqual({ schema: 2 });
    }
    expect(reasons(scrubBatch(null, OPTS))).toEqual({ schema: 1 });
    expect(reasons(scrubBatch([], OPTS))).toEqual({ schema: 1 });
    expect(reasons(scrub([]))).toEqual({ schema: 1 });
    expect(reasons(scrub(Array.from({ length: 101 }, () => event('app.start'))))).toEqual({
      too_large: 101,
    });
    expect(scrub(Array.from({ length: 100 }, () => event('app.start'))).accepted).toHaveLength(100);
  });

  it('keeps the good events of a mixed batch and counts the rest by reason', () => {
    const result = scrub([
      event('app.start'),
      event('command.run', { name: 'a/b' }),
      event('unknown.thing'),
      event('agent.state_change', { from: 'nope', to: 'idle' }),
      event('perf.frame', { p95_ms: 'fast' }),
    ]);
    expect(result.accepted.map((e) => e.type)).toEqual(['app.start']);
    expect(reasons(result)).toEqual({
      pii_pattern: 1,
      type_unknown: 1,
      enum_unknown: 1,
      schema: 1,
    });
  });
});

describe('PII shapes', () => {
  it('flags paths, URLs, addresses, e-mails, host names and long strings, not plain words', () => {
    for (const value of [
      '/etc/passwd',
      'a\\b',
      'x@y',
      'ssh:host',
      '192.168.1.20',
      'fe80::1',
      'db.internal',
      'x'.repeat(65),
    ]) {
      expect(looksLikePii(value), value).toBe(true);
    }
    for (const value of ['login', 'split_view', 'editor.split', 'v1-beta']) {
      expect(looksLikePii(value), value).toBe(false);
    }
  });
});

describe('the per-address key', () => {
  it('is an HMAC of the hour and address: no address in it, and it changes every hour', () => {
    const salt = new Secret('s'.repeat(32));
    const key = addressKey(salt, '203.0.113.7', T0);
    expect(key).toMatch(/^telemetry:ip:[0-9a-f]{32}$/);
    expect(key).not.toContain('203');
    expect(addressKey(salt, '203.0.113.7', T0 + 60_000)).toBe(key);
    expect(addressKey(salt, '203.0.113.7', T0 + 3_600_000)).not.toBe(key);
    expect(addressKey(salt, '203.0.113.8', T0)).not.toBe(key);
    expect(addressKey(new Secret('t'.repeat(32)), '203.0.113.7', T0)).not.toBe(key);
  });
});

describe('configuration', () => {
  it('fixes retention at 90 days and caps batches at 100 events and 64 KiB', () => {
    const config = loadTelemetryConfig({});
    expect(config).toMatchObject({ retentionDays: 90, maxEvents: 100, maxBytes: 65_536 });
    expect(config.ipSalt.reveal()).toHaveLength(43);
    expect(() => loadTelemetryConfig({ TELEMETRY_RETENTION_DAYS: '30' })).toThrow(
      /TELEMETRY_RETENTION_DAYS/,
    );
    expect(() => loadTelemetryConfig({ TELEMETRY_RETENTION_DAYS: '365' })).toThrow(
      /TELEMETRY_RETENTION_DAYS/,
    );
    expect(() => loadTelemetryConfig({ TELEMETRY_BATCH_MAX_EVENTS: '101' })).toThrow(
      /TELEMETRY_BATCH_MAX_EVENTS/,
    );
    expect(() => loadTelemetryConfig({ TELEMETRY_BATCH_MAX_BYTES: '65537' })).toThrow(
      /TELEMETRY_BATCH_MAX_BYTES/,
    );
    expect(() => loadTelemetryConfig({ TELEMETRY_IP_SALT: 'short' })).toThrow(/TELEMETRY_IP_SALT/);
  });
});
