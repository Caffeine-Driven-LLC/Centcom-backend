/**
 * The per-member limit on sequenced frames (B041 acceptance 5): 30/s sustained with a burst of 100
 * passes without drops; past it frames are dropped (never queued) with `sys.slow_down
 * {for_ms: 1000, reason: "rate"}` at most once a second; 5 s of continuous excess closes 4429
 * after a `sys.error frame_rate_exceeded`, while a member who pauses for the second it was asked
 * to starts afresh. One bucket per member, shared by its connections, gone with the last one.
 */
import { newId } from '@centcom/contracts';
import { createManualClock } from '@centcom/testkit/sim';
import { afterEach, describe, expect, it } from 'vitest';
import { CloseCode } from '../../src/close-codes.js';
import { MemberRateLimiter, SLOW_DOWN_MS, VIOLATION_CLOSE_MS } from '../../src/seq/rate-limit.js';
import { SEQ_METRICS } from '../../src/seq/stage.js';
import type { FakeConnection } from '../connection/helpers.js';
import {
  clientFrame,
  reaction,
  seqRelay,
  sentOf,
  T0,
  unitSequencer,
  until,
  type SeqRelay,
  type UnitSequencer,
} from './helpers.js';

/** Sends a frame at the clock's current time; true when it was sequenced. */
async function send(unit: UnitSequencer, fake: FakeConnection, sid: string): Promise<boolean> {
  return (await unit.inbound(fake, clientFrame(sid))).passed;
}

/** Moves the unit's clock to `T0 + ms`. */
const at = (unit: UnitSequencer, ms: number): void =>
  unit.clock.advance(T0 + ms - unit.clock.now());

const closeOf = (fake: FakeConnection) => fake.events.find((e) => e.kind === 'close');

describe('the token bucket', () => {
  it('passes a burst of 100 at once and drops the 101st', () => {
    const limiter = new MemberRateLimiter({ rate: 30, burst: 100 });
    limiter.attach('m', 0);
    const decisions = Array.from({ length: 101 }, () => limiter.take('m', 0));
    expect(decisions.filter((d) => d === 'pass')).toHaveLength(100);
    expect(decisions[100]).toBe('drop');
  });

  it('refills exactly 30 tokens a second, never above the burst', () => {
    const limiter = new MemberRateLimiter({ rate: 30, burst: 100 });
    limiter.attach('m', 0);
    for (let i = 0; i < 100; i += 1) limiter.take('m', 0);
    const after1s = Array.from({ length: 31 }, () => limiter.take('m', 1_000));
    expect(after1s.filter((d) => d === 'pass')).toHaveLength(30);
    const afterLong = Array.from({ length: 101 }, () => limiter.take('m', 1_000_000));
    expect(afterLong.filter((d) => d === 'pass')).toHaveLength(100);
  });

  it('passes a member it does not know (no bucket, no limit) and refuses bad settings', () => {
    const limiter = new MemberRateLimiter({ rate: 30, burst: 100 });
    expect(limiter.take('unknown', 0)).toBe('pass');
    expect(() => new MemberRateLimiter({ rate: 0, burst: 1 })).toThrow(TypeError);
    expect(() => new MemberRateLimiter({ rate: 1, burst: 1.5 })).toThrow(TypeError);
  });

  it('keeps one bucket per key until its last user detaches', () => {
    const limiter = new MemberRateLimiter({ rate: 30, burst: 100 });
    limiter.attach('m', 0);
    limiter.attach('m', 0);
    expect(limiter.size).toBe(1);
    limiter.detach('m');
    expect(limiter.size).toBe(1);
    limiter.detach('m');
    limiter.detach('m');
    expect(limiter.size).toBe(0);
  });
});

describe('the limit on a member’s sequenced frames (unit)', () => {
  it('passes 30/s sustained for 60 s without a drop', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    let drops = 0;
    for (let i = 0; i < 1_800; i += 1) {
      at(unit, Math.round((i * 1_000) / 30));
      if (!(await send(unit, member, sid))) drops += 1;
    }
    expect(drops).toBe(0);
    expect(await unit.store.head(sid)).toBe(1_800);
    expect(sentOf(member, 'sys.slow_down')).toEqual([]);
  });

  it('passes bursts of up to 100 once the bucket has refilled, and 30/s right after a burst of 70', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    let drops = 0;
    for (let round = 0; round < 10; round += 1) {
      at(unit, round * 3_400);
      for (let i = 0; i < 100; i += 1) if (!(await send(unit, member, sid))) drops += 1;
    }
    const start = 10 * 3_400;
    at(unit, start);
    for (let i = 0; i < 70; i += 1) if (!(await send(unit, member, sid))) drops += 1;
    for (let i = 1; i <= 300; i += 1) {
      at(unit, start + Math.round((i * 1_000) / 30));
      if (!(await send(unit, member, sid))) drops += 1;
    }
    expect(drops).toBe(0);
  });

  it('31 frames within a second after the burst is spent: the excess is dropped, with one sys.slow_down', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    for (let i = 0; i < 100; i += 1) await send(unit, member, sid);
    let passed = 0;
    for (let i = 0; i < 31; i += 1) {
      at(unit, 1 + i * 32);
      if (await send(unit, member, sid)) passed += 1;
    }
    expect(passed).toBeLessThanOrEqual(30);
    expect(passed).toBeGreaterThan(0);
    expect(await unit.store.head(sid)).toBe(100 + passed);
    expect(sentOf(member, 'sys.slow_down')).toEqual([
      { v: 1, t: 'sys.slow_down', p: { for_ms: SLOW_DOWN_MS, reason: 'rate' } },
    ]);
    expect(unit.recorded.count(SEQ_METRICS.sequenced, { outcome: 'rate_limited' })).toBe(
      31 - passed,
    );
    expect(closeOf(member)).toBeUndefined();
  });

  it('closes 4429 after 5 s of continuous excess, with sys.error frame_rate_exceeded first, and sends sys.slow_down once a second meanwhile', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    for (let i = 0; i < 100; i += 1) await send(unit, member, sid);
    let firstDrop: number | undefined;
    for (let t = 10; t <= 6_000 && closeOf(member) === undefined; t += 10) {
      at(unit, t);
      const ok = await send(unit, member, sid);
      if (!ok && firstDrop === undefined) firstDrop = t;
    }
    const close = closeOf(member);
    expect(close).toMatchObject({ kind: 'close', code: CloseCode.RateLimited });
    const closedAt = (close as { at: number }).at - T0;
    expect(closedAt - (firstDrop ?? 0)).toBeGreaterThanOrEqual(VIOLATION_CLOSE_MS);
    expect(closedAt - (firstDrop ?? 0)).toBeLessThan(VIOLATION_CLOSE_MS + 20);
    const frames = member.sent();
    const error = frames.at(-1);
    expect(error).toMatchObject({
      t: 'sys.error',
      p: { code: 'frame_rate_exceeded', status: 429, retry_after_s: expect.any(Number) },
    });
    const slowDowns = sentOf(member, 'sys.slow_down').length;
    expect(slowDowns).toBeGreaterThanOrEqual(5);
    expect(slowDowns).toBeLessThanOrEqual(6);
    // Frames after the close are dropped unread.
    const sent = member.sent().length;
    await send(unit, member, sid);
    expect(member.sent()).toHaveLength(sent);
  });

  it('starts afresh after the member pauses for the second it was asked to', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    for (let i = 0; i < 100; i += 1) await send(unit, member, sid);
    const flood = async (from: number, to: number): Promise<void> => {
      for (let t = from; t <= to; t += 10) {
        at(unit, t);
        await send(unit, member, sid);
      }
    };
    await flood(10, 4_000);
    // Quiet for over a second (the refill delays the next drop further): a new violation starts
    // at about 5.57 s.
    await flood(5_100, 9_000);
    expect(closeOf(member)).toBeUndefined();
    // Quiet for 600 ms: the next drop comes under a second after the last one, so the violation
    // goes on and is closed 5 s after it began.
    await flood(9_600, 11_000);
    expect(closeOf(member)).toMatchObject({ code: CloseCode.RateLimited });
    const closedAt = (closeOf(member) as { at: number }).at - T0;
    expect(closedAt).toBeGreaterThan(10_500);
    expect(closedAt).toBeLessThan(10_700);
  });

  it('shares one bucket between a member’s connections, not between members', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = newId('mem');
    const laptop = unit.join(sid, member);
    const phone = unit.join(sid, member);
    const other = unit.join(sid);
    let passed = 0;
    for (let i = 0; i < 60; i += 1) {
      if (await send(unit, laptop, sid)) passed += 1;
      if (await send(unit, phone, sid)) passed += 1;
    }
    expect(passed).toBe(100);
    let otherPassed = 0;
    for (let i = 0; i < 100; i += 1) if (await send(unit, other, sid)) otherPassed += 1;
    expect(otherPassed).toBe(100);
    expect(unit.sequencer.stats().buckets).toBe(2);
    laptop.closeSocket();
    phone.closeSocket();
    expect(unit.sequencer.stats().buckets).toBe(1);
  });

  it('does not limit pure acks or presence frames', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    await send(unit, member, sid);
    for (let i = 0; i < 500; i += 1) {
      await unit.inbound(member, { v: 1, t: 'ack', sid, ack: 1 });
      const presence = { v: 1, t: 'presence', sid, k: 'presence.update', p: { state: 'active' } };
      expect((await unit.inbound(member, presence)).passed).toBe(true);
    }
    expect(sentOf(member, 'sys.slow_down')).toEqual([]);
    expect(await send(unit, member, sid)).toBe(true);
  });
});

describe('the limit on a running relay', () => {
  let live: SeqRelay | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('slows a flooding SimClient down, then closes it 4429 after 5 s of excess', async () => {
    const clock = createManualClock(T0);
    const relay = await seqRelay({ clock: clock.now });
    live = relay;
    const client = await relay.client();
    const frame = () =>
      JSON.stringify({
        v: 1,
        t: 'event',
        id: newId('msg'),
        sid: relay.sid,
        k: 'reaction',
        p: reaction(),
      });
    for (let i = 0; i < 100; i += 1) await client.send('reaction', reaction());
    client.sendRaw(frame());
    const slow = await client.waitFor((f) => f.t === 'sys.slow_down');
    expect(slow.p).toEqual({ for_ms: 1_000, reason: 'rate' });
    const limited = (): number =>
      relay.relay.recorded.count(SEQ_METRICS.sequenced, { outcome: 'rate_limited' });
    // 40/s against 30/s: every 100 ms of the relay's clock, 4 frames, each read at that time.
    for (let t = 0; t < 5_200 && client.isOpen; t += 100) {
      clock.advance(100);
      const before = limited() + relay.store.size(relay.sid);
      for (let i = 0; i < 4; i += 1) client.sendRaw(frame());
      await until(() => !client.isOpen || limited() + relay.store.size(relay.sid) >= before + 4);
    }
    const closed = await client.waitForClose();
    expect(closed.code).toBe(CloseCode.RateLimited);
    expect(client.wire.filter((f) => f.t === 'sys.error').at(-1)?.p).toMatchObject({
      code: 'frame_rate_exceeded',
    });
    expect(relay.store.size(relay.sid)).toBeLessThan(100 + 5 * 30 + 5);
  }, 20_000);
});
