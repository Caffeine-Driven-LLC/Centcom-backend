/**
 * The DurableAppend port (B041 acceptance 8): each frame is handed to it after the buffer append,
 * without waiting; when it rejects, the frame is still delivered, `relay_durable_append_failed_total`
 * counts the failure, and the append is retried up to 5 times with doubling, jittered delays, then
 * given up; the backlog is bounded and `stop` cancels what waits.
 */
import { newId } from '@centcom/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDurableAppender,
  DURABLE_ATTEMPT_TIMEOUT_MS,
  DURABLE_FAILED_METRIC,
  DURABLE_GIVEN_UP_METRIC,
  DURABLE_MAX_DELAY_MS,
  DURABLE_RETRIES,
  noDurableAppend,
  retryDelayMs,
} from '../../src/seq/durable.js';
import type { DurableAppend, StoredFrame } from '../../src/seq/types.js';
import { captureLogger } from '../helpers.js';
import { manualTimers } from '../connection/helpers.js';
import {
  clientFrame,
  reaction,
  seqMetrics,
  seqRelay,
  unitSequencer,
  until,
  type SeqRelay,
} from './helpers.js';

/** Lets settled promises run their callbacks. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A port that fails `failures` times (forever by default), recording each call's time. */
function flakyPort(
  clock: () => number,
  failures = Number.POSITIVE_INFINITY,
): DurableAppend & {
  calls: { seq: number; at: number }[];
} {
  const calls: { seq: number; at: number }[] = [];
  return {
    calls,
    append(_sid, frame) {
      calls.push({ seq: frame.seq, at: clock() });
      return calls.length <= failures
        ? Promise.reject(new Error('history down'))
        : Promise.resolve();
    },
  };
}

describe('the durable append (unit)', () => {
  it('still delivers the frame when the port rejects, then retries 5 times with backoff and gives up', async () => {
    const log = captureLogger();
    const timers = manualTimers();
    const delays: number[] = [];
    const unit = unitSequencer({
      logger: log.logger,
      setTimer: (fn, ms) => {
        delays.push(ms);
        return timers.setTimer(fn, ms);
      },
    });
    const port = flakyPort(timers.clock.now);
    unit.sequencer.service.setDurableAppend(port);
    const sid = newId('ses');
    const member = unit.join(sid);
    const { passed, stored } = await unit.inbound(member, clientFrame(sid));
    expect(passed).toBe(true);
    expect(stored?.seq).toBe(1);
    expect(member.sent()[0]).toMatchObject({ t: 'event', seq: 1 });
    expect(await unit.store.head(sid)).toBe(1);

    await flush();
    for (let i = 0; i < 10; i += 1) {
      timers.clock.advance(DURABLE_MAX_DELAY_MS);
      await flush();
    }
    expect(port.calls).toHaveLength(1 + DURABLE_RETRIES);
    // random() is 0.5 here: three quarters of 250, 500, 1 000, 2 000 and 4 000 ms (besides each
    // attempt's own time limit).
    expect(delays.filter((ms) => ms !== DURABLE_ATTEMPT_TIMEOUT_MS)).toEqual([
      188, 375, 750, 1_500, 3_000,
    ]);
    expect(delays.filter((ms) => ms === DURABLE_ATTEMPT_TIMEOUT_MS)).toHaveLength(6);
    expect(unit.recorded.count(DURABLE_FAILED_METRIC)).toBe(1 + DURABLE_RETRIES);
    expect(unit.recorded.count(DURABLE_GIVEN_UP_METRIC)).toBe(1);
    expect(unit.sequencer.stats().durablePending).toBe(0);
    const gaveUp = log.lines().find((l) => l['msg'] === 'relay.durable_append_gave_up');
    expect(gaveUp).toMatchObject({ seq: 1, attempts: 6, reason: 'retries' });
    expect(log.raw()).not.toContain(sid);
  });

  it('stops retrying once an append succeeds', async () => {
    const unit = unitSequencer();
    const port = flakyPort(unit.clock.now, 2);
    unit.sequencer.service.setDurableAppend(port);
    const sid = newId('ses');
    await unit.inbound(unit.join(sid), clientFrame(sid));
    for (let i = 0; i < 10; i += 1) {
      await flush();
      unit.clock.advance(DURABLE_MAX_DELAY_MS);
    }
    expect(port.calls).toHaveLength(3);
    expect(unit.recorded.count(DURABLE_FAILED_METRIC)).toBe(2);
    expect(unit.recorded.count(DURABLE_GIVEN_UP_METRIC)).toBe(0);
    expect(unit.sequencer.stats().durablePending).toBe(0);
  });

  it('hands every new frame to the port after its buffer append, and never waits for it', async () => {
    const seen: StoredFrame[] = [];
    let release: () => void = () => undefined;
    const hanging: DurableAppend = {
      append: async (_sid, frame) => {
        seen.push(frame);
        await new Promise<void>((resolve) => (release = resolve));
      },
    };
    const unit = unitSequencer({ durable: hanging });
    const sid = newId('ses');
    const member = unit.join(sid);
    for (let i = 0; i < 3; i += 1)
      expect((await unit.inbound(member, clientFrame(sid))).passed).toBe(true);
    expect(seen.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(await unit.store.range(sid, 0, 10)).toEqual(seen);
    expect(unit.sequencer.stats().durablePending).toBe(3);
    release();
  });

  it('counts an attempt that has not settled after 10 s as failed, retries it, and gives up', async () => {
    const unit = unitSequencer();
    let calls = 0;
    unit.sequencer.service.setDurableAppend({
      append: () => {
        calls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const sid = newId('ses');
    expect((await unit.inbound(unit.join(sid), clientFrame(sid))).passed).toBe(true);
    unit.clock.advance(DURABLE_ATTEMPT_TIMEOUT_MS - 1);
    await flush();
    expect(unit.recorded.count(DURABLE_FAILED_METRIC)).toBe(0);
    unit.clock.advance(1);
    await flush();
    expect(unit.recorded.count(DURABLE_FAILED_METRIC)).toBe(1);
    for (let i = 0; i < 20; i += 1) {
      unit.clock.advance(DURABLE_ATTEMPT_TIMEOUT_MS);
      await flush();
    }
    expect(calls).toBe(1 + DURABLE_RETRIES);
    expect(unit.recorded.count(DURABLE_FAILED_METRIC)).toBe(1 + DURABLE_RETRIES);
    expect(unit.recorded.count(DURABLE_GIVEN_UP_METRIC)).toBe(1);
    expect(unit.sequencer.stats().durablePending).toBe(0);
  });

  it('counts a port that throws instead of rejecting as a failure', async () => {
    const unit = unitSequencer({
      durable: {
        append: () => {
          throw new Error('sync');
        },
      },
    });
    const sid = newId('ses');
    expect((await unit.inbound(unit.join(sid), clientFrame(sid))).passed).toBe(true);
    await flush();
    expect(unit.recorded.count(DURABLE_FAILED_METRIC)).toBe(1);
  });

  it('uses a port set later for later frames', async () => {
    const unit = unitSequencer();
    const sid = newId('ses');
    const member = unit.join(sid);
    await unit.inbound(member, clientFrame(sid));
    const port = flakyPort(unit.clock.now, 0);
    unit.sequencer.service.setDurableAppend(port);
    await unit.inbound(member, clientFrame(sid));
    expect(port.calls.map((c) => c.seq)).toEqual([2]);
  });
});

describe('the appender', () => {
  const frame = (seq: number): StoredFrame =>
    ({
      v: 1,
      t: 'event',
      id: newId('msg'),
      sid: 's',
      from: 'm',
      ts: 't',
      seq,
      k: 'reaction',
      p: reaction(),
    }) as StoredFrame;

  it('gives a frame up at once when the backlog is full', async () => {
    const recorded = seqMetrics();
    const appender = createDurableAppender({
      port: { append: () => new Promise<void>(() => undefined) },
      metrics: recorded.metrics,
      maxPending: 2,
    });
    appender.append('s', frame(1));
    appender.append('s', frame(2));
    appender.append('s', frame(3));
    expect(appender.pending()).toBe(2);
    expect(recorded.count(DURABLE_GIVEN_UP_METRIC)).toBe(1);
  });

  it('cancels waiting retries on stop and ignores appends after it', async () => {
    const timers = manualTimers();
    const recorded = seqMetrics();
    let calls = 0;
    const appender = createDurableAppender({
      port: {
        append: () => {
          calls += 1;
          return Promise.reject(new Error('down'));
        },
      },
      metrics: recorded.metrics,
      setTimer: timers.setTimer,
    });
    appender.append('s', frame(1));
    await flush();
    expect(timers.armed()).toBe(1);
    appender.stop();
    expect(timers.armed()).toBe(0);
    expect(appender.pending()).toBe(0);
    appender.append('s', frame(2));
    timers.clock.advance(60_000);
    await flush();
    expect(calls).toBe(1);
  });

  it('keeps nothing by default', async () => {
    await expect(noDurableAppend.append('s', frame(1))).resolves.toBeUndefined();
  });

  it('jitters each delay between half and all of its doubling ceiling, capped at 10 s', () => {
    expect(retryDelayMs(1, () => 0)).toBe(125);
    expect(retryDelayMs(1, () => 0.999_999)).toBe(250);
    expect(retryDelayMs(3, () => 0)).toBe(500);
    expect(retryDelayMs(10, () => 0.999_999)).toBe(DURABLE_MAX_DELAY_MS);
    expect(retryDelayMs(10, () => 0)).toBe(DURABLE_MAX_DELAY_MS / 2);
  });
});

describe('the durable append on a running relay', () => {
  let live: SeqRelay | undefined;
  afterEach(async () => {
    await live?.stop();
    live = undefined;
  });

  it('delivers frames while the port fails, and counts the failures', async () => {
    const relay = await seqRelay({ durable: { append: () => Promise.reject(new Error('down')) } });
    live = relay;
    const sender = await relay.client();
    const watcher = await relay.client();
    const { seq } = await sender.send('reaction', reaction());
    expect(seq).toBe(1);
    await until(() => watcher.wire.some((f) => f.seq === 1));
    await until(() => relay.relay.recorded.count(DURABLE_FAILED_METRIC) >= 1);
  });
});
