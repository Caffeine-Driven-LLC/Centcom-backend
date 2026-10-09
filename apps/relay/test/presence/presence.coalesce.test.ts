/**
 * Inbound and outbound rates (B047; tests "presence.coalesce.test.ts", acceptance 1 and 8, failure
 * mode "flood"): 10 `presence.update` frames from a member in one second give at most 2 fan-out
 * frames in that second, the last carrying the final value. A fast-check property over any
 * timing: frames go out at least max(RELAY_PRESENCE_IN_MS, RELAY_PRESENCE_OUT_MS) apart, never
 * more than 2 in any second, each carrying the latest value at that moment, and the final value
 * always goes out. Updates are overwritten in place, never queued. 1 000 members' updates across
 * 20 sessions cost under 10 % of one core.
 */
import { newId } from '@centcom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { presenceOf, presenceUnit } from './helpers.js';

const STATUSES = ['online', 'away', 'busy'] as const;
const ACTIVITIES = ['idle', 'typing', 'reviewing', 'running'] as const;

describe('10 updates in one second (acceptance 1)', () => {
  it('at most 2 frames that second, the last with the final value', async () => {
    const u = presenceUnit();
    const sender = u.join();
    const watcher = u.join();
    const start = u.time.now();
    for (let i = 0; i < 10; i += 1) {
      u.time.advanceTo(start + i * 100);
      await u.update(sender, { status: 'online', activity: ACTIVITIES[i % 4], agent_count: i });
    }
    u.time.advanceTo(start + 1_000);
    const got = presenceOf(watcher);
    expect(got.length).toBeLessThanOrEqual(2);
    expect(got.at(-1)?.[1]).toEqual({
      status: 'online',
      activity: ACTIVITIES[9 % 4],
      agent_count: 9,
    });
    expect(
      u.recorded.count('relay_presence_updates_total', { result: 'coalesced' }),
    ).toBeGreaterThan(0);
    // Nothing waits: one pending value at most.
    expect(u.time.pending()).toBe(0);
  });
});

describe('any timing (property)', () => {
  it('spaces frames, keeps the latest, and always sends the final value', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 1_500 }),
            status: fc.constantFrom(...STATUSES),
            activity: fc.constantFrom(...ACTIVITIES),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        async (updates) => {
          const u = presenceUnit();
          const member = newId('mem');
          const sender = u.join(member);
          const watcher = u.join();
          const sent: { at: number; p: unknown; current: unknown }[] = [];
          const latest: { at: number; p: unknown }[] = [];
          const original = watcher.sendText?.bind(watcher);
          watcher.sendText = (text) => {
            const f = JSON.parse(text) as Record<string, unknown>;
            if (f['t'] === 'presence') {
              sent.push({ at: u.time.now(), p: f['p'], current: latest.at(-1)?.p });
            }
            return original?.(text) ?? false;
          };
          let t = u.time.now();
          for (const x of updates) {
            t += x.gap;
            u.time.advanceTo(t);
            const p = { status: x.status, activity: x.activity };
            latest.push({ at: t, p });
            await u.update(sender, p);
          }
          u.time.advanceTo(t + 5_000);
          for (let i = 1; i < sent.length; i += 1) {
            expect((sent[i]?.at ?? 0) - (sent[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1_000);
          }
          for (const s of sent) {
            const inWindow = sent.filter((o) => o.at >= s.at && o.at < s.at + 1_000);
            expect(inWindow.length).toBeLessThanOrEqual(2);
            // The value that was the latest when it went out.
            expect(s.p).toEqual(s.current);
          }
          expect(sent.at(-1)?.p).toEqual(latest.at(-1)?.p);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('with RELAY_PRESENCE_IN_MS 0 the out limit (500 ms) still holds', async () => {
    const u = presenceUnit({ config: { inMs: 0 } });
    const sender = u.join();
    const watcher = u.join();
    const start = u.time.now();
    for (let i = 0; i < 20; i += 1) {
      u.time.advanceTo(start + i * 50);
      await u.update(sender, { status: 'online', activity: ACTIVITIES[i % 4] });
    }
    u.time.advanceTo(start + 1_000);
    expect(presenceOf(watcher)).toHaveLength(3);
  });
});

describe('cost (acceptance 8)', () => {
  it('1 000 members across 20 sessions: under 10 % of one core', async () => {
    const u = presenceUnit();
    const members: { conn: ReturnType<typeof u.join> }[] = [];
    for (let s = 0; s < 20; s += 1) {
      const session = newId('ses');
      for (let m = 0; m < 50; m += 1) members.push({ conn: u.join(newId('mem'), session) });
    }
    const seconds = 10;
    const start = u.time.now();
    const cpu = process.cpuUsage();
    for (let second = 0; second < seconds; second += 1) {
      // Every member updates once a second (the client's own limit), spread over the second.
      for (let i = 0; i < members.length; i += 1) {
        u.time.advanceTo(start + second * 1_000 + Math.floor((i * 1_000) / members.length));
        await u.update(members[i]?.conn as never, {
          status: STATUSES[(second + i) % 3],
          activity: ACTIVITIES[(second + i) % 4],
        });
      }
    }
    u.time.advanceTo(start + (seconds + 2) * 1_000);
    const used = process.cpuUsage(cpu);
    const cpuMs = (used.user + used.system) / 1_000;
    // Ten seconds of updates, with every frame to the session's 50 connections.
    expect(cpuMs, `${cpuMs} ms of CPU`).toBeLessThan(seconds * 1_000 * 0.1);
    expect(u.presence.size()).toBe(1_000);
  }, 60_000);
});
