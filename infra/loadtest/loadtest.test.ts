/**
 * The load test tooling (B095): the target allow-list, the histogram, the load client against the
 * testkit's in-process reference relay (delivery latency, sequence tracking, resume, random
 * ciphertext), the capacity model (arithmetic, N+1, staleness) and the runner's refusals. The relay
 * itself is not started here; `pnpm loadtest:relay` does that, with Docker.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { newId } from '@centcom/contracts';
import { LoopbackRelay, mintTestTicket } from '@centcom/testkit/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoadClient } from './client.js';
import {
  LAUNCH_TARGETS,
  MAX_MEASUREMENT_AGE_DAYS,
  StaleMeasurementError,
  measurementsFrom,
  plan,
  renderMarkdown,
  type Measurements,
} from './capacity.js';
import { Histogram } from './hist.js';
import { assertAllowedTarget, hostOf, isAllowedTarget, TargetRefusedError } from './targets.js';

const ROOT = join(import.meta.dirname, '..', '..');

describe('targets', () => {
  it('allows localhost, loopback addresses and *.stage.centcom.dev', () => {
    for (const t of [
      'localhost',
      'localhost:3000',
      '127.0.0.1',
      'ws://127.0.0.1:8080/v1/ws',
      'http://localhost:3000',
      'ws://[::1]:8080/v1/ws',
      'https://api.stage.centcom.dev',
      'wss://relay.eu.stage.centcom.dev/v1/ws',
    ]) {
      expect(isAllowedTarget(t), t).toBe(true);
    }
  });

  it('refuses production and everything else', () => {
    for (const t of [
      'api.centcom.dev',
      'https://api.centcom.dev',
      'wss://relay.centcom.dev/v1/ws',
      'centcom.dev',
      'stage.centcom.dev',
      'https://evilstage.centcom.dev',
      'https://api.stage.centcom.dev.evil.example',
      'http://localhost.evil.example',
      'example.com',
      '10.0.0.5',
      '',
    ]) {
      expect(isAllowedTarget(t), t).toBe(false);
      expect(() => assertAllowedTarget(t)).toThrow(TargetRefusedError);
    }
    expect(hostOf('wss://RELAY.example.com:443/x')).toBe('relay.example.com');
  });

  it('the runner exits 2 for a refused target and for bad arguments, before starting anything', () => {
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', join(ROOT, 'infra/loadtest/relay-load.ts'), ...args],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.test.json'),
          },
          timeout: 60_000,
        },
      );
    const refused = run('--profile', 'smoke', '--url', 'wss://api.centcom.dev/v1/ws');
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('refusing to run against');
    expect(run('--profile', 'nonsense').status).toBe(2);
    expect(run('--bogus').status).toBe(2);
    // an allowed host that this runner cannot mint tickets for is also refused cleanly
    expect(run('--profile', 'smoke', '--url', 'ws://localhost:1/v1/ws').status).toBe(2);
  }, 120_000);
});

describe('Histogram', () => {
  it('reports percentiles within the 3 % bucket width and never under-reports', () => {
    const h = new Histogram();
    for (let i = 1; i <= 1000; i += 1) h.add(i / 10); // 0.1 .. 100 ms
    const p95 = h.percentile(95);
    expect(p95).toBeGreaterThanOrEqual(95);
    expect(p95).toBeLessThan(95 * 1.04);
    expect(h.percentile(100)).toBe(100);
    expect(new Histogram().percentile(99)).toBe(0);
  });

  it('merges counts and survives a JSON round trip', () => {
    const a = new Histogram();
    const b = new Histogram();
    for (let i = 0; i < 100; i += 1) a.add(5);
    for (let i = 0; i < 100; i += 1) b.add(500);
    a.merge(Histogram.from(JSON.parse(JSON.stringify(b)) as { counts: number[]; max: number }));
    expect(a.total).toBe(200);
    expect(a.percentile(40)).toBeLessThan(6);
    expect(a.percentile(60)).toBeGreaterThan(450);
    expect(a.max).toBe(500);
  });
});

describe('LoadClient against the reference relay', () => {
  let relay: LoopbackRelay;
  beforeAll(async () => {
    relay = await LoopbackRelay.start();
  });
  afterAll(async () => {
    await relay.close();
  });

  const member = (
    sid: string,
    role: 'host' | 'editor',
    latencies: number[],
    closes: number[] = [],
  ) => {
    const mid = newId('mem');
    const dev = newId('dev');
    return new LoadClient({
      url: relay.url,
      sid,
      ticket: () => mintTestTicket({ sid, mid, role, dev }),
      events: { delivery: (ms) => latencies.push(ms), closed: (code) => closes.push(code) },
    });
  };
  const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
    for (let waited = 0; waited < ms && !ok(); waited += 20)
      await new Promise((r) => setTimeout(r, 20));
  };

  it('delivers a host event to every member with a measured latency and no gap', async () => {
    const sid = newId('ses');
    const lat: number[] = [];
    const host = member(sid, 'host', lat);
    const guests = [member(sid, 'editor', lat), member(sid, 'editor', lat)];
    await Promise.all([host.connect(false), ...guests.map((g) => g.connect(false))]);
    for (let i = 0; i < 20; i += 1) host.sendEvent('message.user');
    await until(() => lat.length >= 60);
    expect(lat).toHaveLength(60);
    for (const ms of lat) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(2000);
    }
    for (const c of [host, ...guests]) {
      expect(c.delivered).toBe(20);
      expect(c.lastSeq).toBeGreaterThanOrEqual(20);
      expect(c.pendingGap).toBe(0);
    }
    [host, ...guests].forEach((c) => c.close());
  });

  it('resumes with its last seq and takes only the frames it missed', async () => {
    const sid = newId('ses');
    const lat: number[] = [];
    const closes: number[] = [];
    const host = member(sid, 'host', lat);
    const guest = member(sid, 'editor', lat, closes);
    await Promise.all([host.connect(false), guest.connect(false)]);
    for (let i = 0; i < 5; i += 1) host.sendEvent('message.user');
    await until(() => guest.delivered === 5);
    guest.kill(); // a dropped network, not a close frame
    await until(() => closes.length > 0);
    for (let i = 0; i < 7; i += 1) host.sendEvent('message.user');
    await until(() => host.delivered === 12);
    await guest.connect(true);
    await until(() => guest.delivered === 12);
    expect(guest.delivered).toBe(12);
    expect(guest.pendingGap).toBe(0);
    expect(guest.lastSeq).toBe(host.lastSeq);
    host.close();
    guest.close();
  });

  it('sends only random bytes: no two frames share ciphertext, and nothing but ids is readable', async () => {
    const sid = newId('ses');
    const host = member(sid, 'host', []);
    await host.connect(false);
    for (let i = 0; i < 10; i += 1) host.sendEvent('message.user');
    await until(() => relay.received.filter((f) => f.sid === sid).length >= 10);
    const frames = relay.received.filter((f) => f.sid === sid);
    expect(new Set(frames.map((f) => JSON.stringify(f.ct))).size).toBe(frames.length);
    for (const f of frames) {
      expect(Object.keys(f).sort()).toEqual(
        ['ct', 'id', 'k', 'seq', 'sid', 'sig', 't', 'v'].filter((k) => k in f).sort(),
      );
      expect(f.p).toBeUndefined();
      expect(Buffer.from(String((f.ct as { c: string }).c), 'base64url').length).toBe(48);
    }
    host.close();
  });
});

describe('capacity model', () => {
  const NOW = new Date('2026-10-14T00:00:00Z');
  const m: Measurements = {
    measuredAt: '2026-10-13T12:00:00Z',
    machine: 'test machine',
    connectionsPerInstance: 2000,
    rampFpsPerSession: 1,
    connectionsAtCpu60: 1500,
    framesPerSecondPerInstance: 400,
    memoryBaseMiB: 160,
    memoryMiBPerConnection: 0.12,
    vcpuPerInstance: 1,
  };

  it('counts instances for 1x, 2x and 5x with one spare, from the tighter of connections and frames', () => {
    const p = plan(LAUNCH_TARGETS, m, { now: NOW });
    expect(p.rows.map((r) => r.multiplier)).toEqual([1, 2, 5]);
    const one = p.rows[0];
    // 20 000 / 1 500 = 14 relays for connections; 5 000 / 400 = 13 for frames
    expect(one).toMatchObject({
      relayInstancesForConnections: 14,
      relayInstancesForFrames: 13,
      relayInstances: 14,
      relayInstancesWithSpare: 15,
      limitedBy: 'connections',
    });
    const five = p.rows[2];
    expect(five).toMatchObject({
      relayInstancesForConnections: 67,
      relayInstancesForFrames: 63,
      relayInstancesWithSpare: 68,
    });
    expect(five?.servers.count).toBeGreaterThan(one?.servers.count ?? 99);
    expect(five?.servers.eurPerMonth).toBeGreaterThan(one?.servers.eurPerMonth ?? 0);
  });

  it('is limited by frames when sessions are busy, and says when the rate was not measured', () => {
    const busy = plan(LAUNCH_TARGETS, { ...m, framesPerSecondPerInstance: 100 }, { now: NOW });
    expect(busy.rows[0]).toMatchObject({
      relayInstancesForFrames: 50,
      relayInstances: 50,
      limitedBy: 'frames',
    });
    const unknown = plan(LAUNCH_TARGETS, { ...m, framesPerSecondPerInstance: null }, { now: NOW });
    expect(unknown.rows[0]?.relayInstancesForFrames).toBeNull();
    expect(unknown.warnings.join(' ')).toContain('No sending-rate test');
    expect(unknown.warnings.join(' ')).toContain('REST API was not load tested');
  });

  it('fails when the measurement is older than 30 days', () => {
    expect(MAX_MEASUREMENT_AGE_DAYS).toBe(30);
    const old = { ...m, measuredAt: '2026-09-01T00:00:00Z' };
    expect(() => plan(LAUNCH_TARGETS, old, { now: NOW })).toThrow(StaleMeasurementError);
    expect(() =>
      plan(LAUNCH_TARGETS, { ...m, measuredAt: '2026-09-14T00:00:00Z' }, { now: NOW }),
    ).not.toThrow();
    expect(() => plan(LAUNCH_TARGETS, { ...m, measuredAt: 'not a date' }, { now: NOW })).toThrow(
      StaleMeasurementError,
    );
  });

  it('derives the figures from ramp and rate reports and renders a table', () => {
    const step = (
      connections: number,
      cpu: number,
      rss: number,
      ok = true,
      fps = 1,
      frames = connections / 5,
    ) => ({
      connections,
      relayCpuCores: cpu,
      relayRssMiB: rss,
      ok,
      fps,
      sequencedFramesPerS: frames,
    });
    const ramp = {
      scenario: 'ramp',
      started_at: '2026-10-13T10:00:00Z',
      environment: { cpu_model: 'X', cpus: 8, memory_gib: 31 },
      steps: [
        step(500, 0.3, 220),
        step(1000, 0.45, 280),
        step(1500, 0.75, 340),
        step(2000, 0.9, 400, false),
      ],
      extra: {},
    };
    const rate = {
      ...ramp,
      scenario: 'rate',
      started_at: '2026-10-13T11:00:00Z',
      steps: [
        step(1000, 0.2, 280, true, 0.5, 100),
        step(1000, 0.5, 280, true, 1, 200),
        step(1000, 0.9, 280, false, 2, 400),
      ],
    };
    const got = measurementsFrom(ramp, rate);
    expect(got.connectionsPerInstance).toBe(1500);
    expect(got.connectionsAtCpu60).toBe(1250); // halfway between 1000 (0.45) and 1500 (0.75)
    expect(got.framesPerSecondPerInstance).toBe(200);
    expect(got.memoryMiBPerConnection).toBeCloseTo(0.12, 2);
    expect(got.measuredAt).toBe('2026-10-13T10:00:00Z');
    const md = renderMarkdown(plan(LAUNCH_TARGETS, got, { now: NOW }), {
      ramp: { file: 'a.json', report: ramp },
      rate: { file: 'b.json', report: rate },
    });
    expect(md).toContain('| 1x | 20000 | 5000 |');
    expect(md).toContain('GENERATED by `pnpm capacity:model`');
    expect(md).toContain('| 500 |');
    expect(md).toContain('A laptop is not a server');
    expect(() => measurementsFrom({ ...ramp, steps: [step(500, 0.3, 220, false)] })).toThrow(
      /no passing step/,
    );
  });
});
