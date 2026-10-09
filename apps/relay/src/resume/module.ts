/**
 * The resume relay module (B042): registers the `sys.resume` stage at order 45 (STAGE_ORDER.resume,
 * between sequencing and fan-out) and offers the handshake its hooks (`ctx.resume`), so a hello
 * with `last_seq` is replayed between the welcome and live traffic.
 *
 * - **Durable log:** with `OBJECT_STORE_*` set, B055's history store (`@centcom/storage`) over the
 *   relay's Postgres and the object store: B041's DurableAppend port writes every sequenced frame
 *   through a `HistoryWriter` (flushed on shutdown), and the replay and hydration read it back.
 *   Without it (development and tests only; refused in production by `loadResumeConfig`) only the
 *   hot buffer is replayed, and the log says so.
 * - **Hydration:** B041's sequencing waits on the hydrator per session (`setReadiness`), so a
 *   session lost from Redis is recovered before its next frame is numbered.
 * - **Snapshots:** none until B056 (`noSnapshots`).
 *
 * A relay without the sequence module (no `ctx.seq`) has nothing to replay: the module registers
 * nothing and says so in the log.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { createDb, HistoryDatabase } from '@centcom/db';
import { createHistoryStore, createS3BlobStore, HistoryWriter } from '@centcom/storage';
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { loadSeqConfig } from '../seq/config.js';
import { loadResumeConfig } from './config.js';
import { historyDurableAppend, historyLogReader } from './durable-log.js';
import { createHydrator } from './hydrate.js';
import { createResumer } from './resume.js';
import { noDurableLog, noSnapshots, type DurableLogReader } from './types.js';

const relayModule: RelayModule = {
  name: 'resume',
  order: STAGE_ORDER.resume,
  register(ctx) {
    const seq = ctx.seq;
    if (seq === undefined) {
      ctx.log.warn({}, 'relay.resume_without_seq');
      return undefined;
    }
    const config = loadResumeConfig();
    let durable: DurableLogReader = noDurableLog;
    if (config.objectStore === null) {
      ctx.log.warn({}, 'relay.resume_without_durable_log');
    } else {
      const store = createHistoryStore({
        db: ctx.db as unknown as ReturnType<typeof createDb<HistoryDatabase>>,
        blobs: createS3BlobStore(config.objectStore),
      });
      const writer = new HistoryWriter({ store, logger: ctx.log, metrics: ctx.metrics });
      seq.setDurableAppend(historyDurableAppend(writer));
      durable = historyLogReader(store);
      ctx.onShutdown(() => writer.flushAll());
    }
    const hydrator = createHydrator({
      store: seq.store,
      durable,
      frames: config.hydrateFrames,
      maxBufferFrames: loadSeqConfig().buffer.maxFrames,
      clock: ctx.clock,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    seq.setReadiness(hydrator.ready);
    const resumer = createResumer({
      store: seq.store,
      durable,
      snapshots: noSnapshots,
      hydrator,
      fanout: () => ctx.fanout,
      batch: config.batch,
      maxFrames: config.maxFrames,
      logger: ctx.log,
      metrics: ctx.metrics,
    });
    ctx.pipeline.use(STAGE_ORDER.resume, resumer.stage);
    ctx.resume = resumer;
    return undefined;
  },
};

export default relayModule;
