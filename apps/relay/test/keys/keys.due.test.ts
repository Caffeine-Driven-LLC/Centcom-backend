/**
 * Scheduled rotation due (B049; tests "keys.due.test.ts", acceptance 8, CT-CRYPTO §5.5): `due()`
 * returns `scheduled` once an epoch is 7 days old or 100 000 frames long, counted once
 * (`relay_epoch_rotation_due_total`); the relay never rotates by itself.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryEpochStore } from '../../src/keys/epoch-store.js';
import { createEpochs, SCHEDULE_AGE_MS, SCHEDULE_FRAMES } from '../../src/keys/epochs.js';
import { recordingMetrics } from '../helpers.js';

function dueUnit() {
  let now = 1_000_000_000;
  let head = 0;
  const recorded = recordingMetrics();
  const emitted: unknown[] = [];
  const epochs = createEpochs({
    store: createMemoryEpochStore(),
    seq: { head: () => Promise.resolve(head) },
    fanout: () => ({
      emitServerBatch: (_sid, frames) => {
        emitted.push(...frames);
        head += frames.length;
        return Promise.resolve(
          frames.map((f, i) => ({ ...f, seq: head - frames.length + i + 1 }) as never),
        );
      },
    }),
    clock: () => now,
    metrics: recorded.metrics,
  });
  return {
    epochs,
    recorded,
    emitted,
    advance: (ms: number) => void (now += ms),
    frames: (n: number) => void (head += n),
  };
}

describe('due (acceptance 8)', () => {
  it('7 days after a rotation: scheduled, counted once; never rotated by the relay', async () => {
    const d = dueUnit();
    const sid = newId('ses');
    await d.epochs.rotate(sid, 'requested');
    d.emitted.length = 0;
    d.advance(SCHEDULE_AGE_MS - 1);
    expect(await d.epochs.due(sid)).toBe('none');
    d.advance(1);
    expect(await d.epochs.due(sid)).toBe('scheduled');
    expect(await d.epochs.due(sid)).toBe('scheduled');
    expect(d.recorded.count('relay_epoch_rotation_due_total')).toBe(1);
    expect(d.emitted).toEqual([]);
  });

  it('100 000 frames since the rotation: scheduled; a new rotation resets it', async () => {
    const d = dueUnit();
    const sid = newId('ses');
    d.frames(SCHEDULE_FRAMES - 1);
    expect(await d.epochs.due(sid)).toBe('none');
    d.frames(1);
    expect(await d.epochs.due(sid)).toBe('scheduled');
    await d.epochs.rotate(sid, 'scheduled');
    expect(await d.epochs.due(sid)).toBe('none');
    expect(d.recorded.count('relay_epoch_rotation_due_total')).toBe(1);
  });
});
