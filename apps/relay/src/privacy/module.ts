/**
 * The privacy relay module (B050, order 30 = STAGE_ORDER.privacy): the privacy gate. The log
 * scrubber and the metric label guard are not a stage: `startRelay` wraps the relay's logger and
 * metrics with them before any module gets them (`createRelayLogger`, `guardMetrics`), so
 * every module's lines and labels are filtered, those registered before this one included.
 *
 * Owns: wiring. Must not: hold state outside what `register` creates.
 */
import type { RelayModule } from '../modules.js';
import { STAGE_ORDER } from '../pipeline.js';
import { privacyStage } from './stage.js';

const relayModule: RelayModule = {
  name: 'privacy',
  order: STAGE_ORDER.privacy,
  register(ctx) {
    ctx.pipeline.use(STAGE_ORDER.privacy, privacyStage({ logger: ctx.log, metrics: ctx.metrics }));
    return undefined;
  },
};

export default relayModule;
