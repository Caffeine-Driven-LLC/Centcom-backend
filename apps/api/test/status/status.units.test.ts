/**
 * Status rules without HTTP (B086 test plan "unit"): worst-of aggregation, probe failure counting
 * with hysteresis, incident ordering and the 7-day expiry, the 32 KiB budget, the admin API's
 * checks, and the configuration.
 */
import { isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_PROBE_STATE,
  nextProbeState,
  worstOf,
  type ProbeState,
} from '../../src/modules/status/aggregate.js';
import { loadStatusConfig } from '../../src/modules/status/config.js';
import {
  MAX_FEED_BYTES,
  StatusAdmin,
  StatusFeed,
  type StatusBody,
} from '../../src/modules/status/service.js';
import { DAY_MS, MemoryStatusRepository, T0 } from './helpers.js';

/** The pointers of the 422 `fn` rejects with. */
async function refused(fn: () => Promise<unknown>): Promise<string[]> {
  try {
    await fn();
  } catch (err) {
    if (isAppError(err) && err.status === 422) return (err.errors ?? []).map((e) => e.pointer);
    throw err;
  }
  throw new Error('expected a 422');
}

const components = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Component ${i}`, probe: null }));

describe('aggregation', () => {
  it('takes the worst component status', () => {
    expect(worstOf([])).toBe('operational');
    expect(worstOf(['operational', 'operational'])).toBe('operational');
    expect(worstOf(['operational', 'degraded', 'operational'])).toBe('degraded');
    expect(worstOf(['degraded', 'partial_outage'])).toBe('partial_outage');
    expect(worstOf(['operational', 'major_outage', 'degraded'])).toBe('major_outage');
  });

  it('degrades on one failure, is a major outage after three, and recovers after two successes', () => {
    const run = (results: boolean[]) => {
      let state: ProbeState = INITIAL_PROBE_STATE;
      return results.map((ok) => (state = nextProbeState(state, ok)).status);
    };
    expect(run([false])).toEqual(['degraded']);
    expect(run([false, false, false])).toEqual(['degraded', 'degraded', 'major_outage']);
    expect(run([false, false, false, true, true])).toEqual([
      'degraded',
      'degraded',
      'major_outage',
      'major_outage',
      'operational',
    ]);
    // Flapping never reaches major_outage, and needs two successes in a row to clear.
    expect(run([false, true, false, true, true])).toEqual([
      'degraded',
      'degraded',
      'degraded',
      'degraded',
      'operational',
    ]);
    expect(run([true, true])).toEqual(['operational', 'operational']);
  });
});

describe('the feed', () => {
  it('lists open incidents first, newest first, with ordered updates, and drops ones resolved over 7 days ago', async () => {
    const repo = new MemoryStatusRepository();
    const clock = { now: T0 - 10 * DAY_MS };
    const admin = new StatusAdmin({
      repository: repo,
      components: components(2),
      clock: () => clock.now,
    });
    const old = await admin.createIncident({
      title: 'Old outage',
      component_ids: ['c0'],
      status: 'investigating',
    });
    clock.now = T0 - 9 * DAY_MS;
    await admin.resolveIncident(old.id);
    clock.now = T0 - 3 * DAY_MS;
    const recent = await admin.createIncident({
      title: 'Recent blip',
      component_ids: [],
      status: 'identified',
    });
    await admin.addIncidentUpdate(recent.id, 'Fixed', 'resolved');
    clock.now = T0 - 2 * DAY_MS;
    const open1 = await admin.createIncident({
      title: 'Slow sync',
      component_ids: ['c1'],
      status: 'investigating',
    });
    clock.now = T0 - DAY_MS;
    const open2 = await admin.createIncident({
      title: 'Relay errors',
      component_ids: ['c0', 'c1'],
      status: 'investigating',
    });
    clock.now = T0 - 60_000;
    await admin.addIncidentUpdate(open2.id, 'Looking into it');
    clock.now = T0 - 30_000;
    await admin.addIncidentUpdate(open2.id, 'Cause found', 'identified');
    clock.now = T0;
    const feed = new StatusFeed({
      prober: { statuses: () => Promise.resolve([]) },
      repository: repo,
      kv: { get: () => Promise.resolve(null) },
      components: [],
      minClientVersion: '1.0.0',
      clock: () => clock.now,
    });
    const body = JSON.parse((await feed.current()).body) as StatusBody;
    expect(body.incidents.map((i) => i.title)).toEqual([
      'Relay errors',
      'Slow sync',
      'Recent blip',
    ]);
    expect(body.incidents[0]).toEqual({
      id: open2.id,
      title: 'Relay errors',
      status: 'identified',
      started_at: new Date(T0 - DAY_MS).toISOString(),
      updates: [
        { at: new Date(T0 - 60_000).toISOString(), text: 'Looking into it' },
        { at: new Date(T0 - 30_000).toISOString(), text: 'Cause found' },
      ],
    });
    expect(body.incidents[2]?.status).toBe('resolved');
    expect(open1.status).toBe('investigating');
  });

  it('stays within 32 KiB with 50 components and 20 incidents, keeping each incident’s newest update', async () => {
    const repo = new MemoryStatusRepository();
    const clock = { now: T0 };
    const admin = new StatusAdmin({
      repository: repo,
      components: components(50),
      clock: () => clock.now,
    });
    for (let i = 0; i < 20; i += 1) {
      const incident = await admin.createIncident({
        title: `Incident ${i} ${'t'.repeat(100)}`,
        component_ids: ['c1'],
        status: 'investigating',
      });
      for (let u = 0; u < 10; u += 1) {
        clock.now += 1000;
        await admin.addIncidentUpdate(incident.id, `Update ${u} ${'x'.repeat(480)}`);
      }
    }
    const feed = new StatusFeed({
      prober: {
        statuses: () =>
          Promise.resolve(
            components(50).map((c) => ({ id: c.id, name: c.name, status: 'operational' as const })),
          ),
      },
      repository: repo,
      kv: { get: () => Promise.resolve(null) },
      components: components(50),
      minClientVersion: '1.0.0',
      clock: () => clock.now,
    });
    const snapshot = await feed.current();
    expect(Buffer.byteLength(snapshot.body)).toBeLessThanOrEqual(MAX_FEED_BYTES);
    const body = JSON.parse(snapshot.body) as StatusBody;
    expect(body.components).toHaveLength(50);
    expect(body.incidents).toHaveLength(20);
    for (const incident of body.incidents) {
      expect(incident.updates.length).toBeGreaterThanOrEqual(1);
      expect(incident.updates.at(-1)?.text).toMatch(/^Update 9 /);
    }
  });
});

describe('the admin API', () => {
  it('checks titles, text, statuses, components and deprecations, and refuses customer data', async () => {
    const repo = new MemoryStatusRepository();
    const admin = new StatusAdmin({ repository: repo, components: components(2), clock: () => T0 });
    expect(
      await refused(() =>
        admin.createIncident({ title: '', component_ids: [], status: 'investigating' }),
      ),
    ).toEqual(['/title']);
    expect(
      await refused(() =>
        admin.createIncident({
          title: 'x'.repeat(121),
          component_ids: [],
          status: 'investigating',
        }),
      ),
    ).toEqual(['/title']);
    expect(
      await refused(() =>
        admin.createIncident({ title: 'Outage', component_ids: ['nope'], status: 'investigating' }),
      ),
    ).toEqual(['/component_ids']);
    expect(
      await refused(() =>
        admin.createIncident({ title: 'Outage', component_ids: [], status: 'panicking' as never }),
      ),
    ).toEqual(['/status']);
    const incident = await admin.createIncident({
      title: 'Outage',
      component_ids: ['c0'],
      status: 'investigating',
    });
    expect(incident.id).toMatch(/^inc_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await refused(() => admin.addIncidentUpdate(incident.id, 'x'.repeat(501)))).toEqual([
      '/text',
    ]);
    for (const text of [
      'Contact ops@example.test',
      'Customer at 203.0.113.9 reported it',
      'token cen_live_abcdef',
    ]) {
      expect(await refused(() => admin.addIncidentUpdate(incident.id, text)), text).toEqual([
        '/text',
      ]);
    }
    expect((await admin.addIncidentUpdate(incident.id, 'x'.repeat(500))).updates).toHaveLength(1);
    await expect(
      admin.addIncidentUpdate('inc_01JA3Z8K2M5N7P9Q0R1S2T3V4W', 'Hi'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(admin.resolveIncident('inc_01JA3Z8K2M5N7P9Q0R1S2T3V4W')).rejects.toMatchObject({
      status: 404,
    });
    expect((await admin.resolveIncident(incident.id)).resolved_at).toBe(new Date(T0).toISOString());
    expect(await refused(() => admin.setDeprecation({ what: '/v1/foo', sunset: 'March' }))).toEqual(
      ['/sunset'],
    );
    expect(await admin.setDeprecation({ what: '/v1/foo', sunset: '2027-03-01' })).toEqual({
      what: '/v1/foo',
      sunset: '2027-03-01',
    });
  });
});

describe('configuration', () => {
  it('reads components, the minimum version, the readiness timeout and the expected migration', () => {
    const config = loadStatusConfig({
      STATUS_COMPONENTS: JSON.stringify([
        { id: 'api', name: 'API' },
        { id: 'relay-eu', name: 'Relay (EU)', probe: { url: 'https://relay-eu.internal/healthz' } },
        { id: 'worker', name: 'Jobs', probe: { heartbeat_key: 'worker:heartbeat' } },
      ]),
      MIN_CLIENT_VERSION: '1.2.0',
    });
    expect(config.components).toEqual([
      { id: 'api', name: 'API', probe: null },
      { id: 'relay-eu', name: 'Relay (EU)', probe: { url: 'https://relay-eu.internal/healthz' } },
      { id: 'worker', name: 'Jobs', probe: { heartbeat_key: 'worker:heartbeat', max_age_s: 60 } },
    ]);
    expect(config).toMatchObject({ minClientVersion: '1.2.0', readyzTimeoutMs: 1000 });
    expect(config.expectedMigrationVersion).toMatch(/^\d{14}$/);
    expect(loadStatusConfig({}).components).toEqual([]);
    for (const STATUS_COMPONENTS of [
      'not json',
      '[{"id":"API","name":"x"}]',
      '[{"id":"a","name":"x"},{"id":"a","name":"y"}]',
      '[{"id":"a","name":"x","probe":{"url":"ftp://x"}}]',
      '[{"id":"a","name":"x","extra":1}]',
      JSON.stringify(components(51)),
    ]) {
      expect(() => loadStatusConfig({ STATUS_COMPONENTS }), STATUS_COMPONENTS.slice(0, 30)).toThrow(
        /STATUS_COMPONENTS/,
      );
    }
    expect(() => loadStatusConfig({ MIN_CLIENT_VERSION: 'one' })).toThrow(/MIN_CLIENT_VERSION/);
    expect(() => loadStatusConfig({ EXPECTED_MIGRATION_VERSION: '2026' })).toThrow(
      /EXPECTED_MIGRATION_VERSION/,
    );
  });
});
