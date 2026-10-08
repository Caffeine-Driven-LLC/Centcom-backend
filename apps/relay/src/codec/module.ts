/**
 * The codec relay module (B039): registers the decode stage at order 10 (STAGE_ORDER.decode), so
 * every inbound message is size-checked first and, once the connection is authenticated, decoded
 * and validated before any other stage sees it.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { createCodecStage } from './stage.js';

const relayModule: RelayModule = {
  name: 'codec',
  order: STAGE_ORDER.decode,
  register(ctx) {
    ctx.pipeline.use(
      STAGE_ORDER.decode,
      createCodecStage({ logger: ctx.log, metrics: ctx.metrics, clock: ctx.clock }),
    );
    return undefined;
  },
};

export default relayModule;
