/**
 * @centcom/contracts: types, validators and helpers generated from contracts/ (lane B003).
 *
 * This entry point is the package's only public surface. Never hand-write a type a contract
 * defines; import it from here. Generated code lives in ./generated and is never edited by hand.
 */
export * from './ids.js';
export * from './money.js';
export * from './text.js';
export * from './time.js';
export * from './validate.js';
export * from './version.js';

export type * from './generated/types.js';
export { EVENT_CATALOGUE, EVENT_KINDS } from './generated/types.js';
export type * as Api from './generated/api.js';
export { ERRORS, ERROR_TYPE_BASE, type ErrorCode } from './generated/errors.js';
export { PRODUCT_STATES, STATE_MAP, type ProductState } from './generated/state-map.js';
