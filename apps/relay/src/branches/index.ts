/**
 * Branch and conflict signalling (B061): `branch.update` passed through unopened, and
 * `conflict.detected` from members and from B059's lock denials. See README.md.
 */
export { BranchHandler, maySignal } from './branch-handler.js';
export { ConflictSignal, type ConflictSignalDeps } from './conflict-signal.js';
export * from './ports.js';
export { redisSignalGate } from './module.js';
export { branchStage } from './stage.js';
