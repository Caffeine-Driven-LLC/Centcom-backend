/**
 * Seat quantity for Team workspaces (B073): the service behind `PATCH /v1/workspaces/{id}/seats`,
 * the daily reconciliation and its source, and the ports (B030's seat accounting, the seat lock).
 * See README.md.
 */
export {
  createSeatLock,
  SEAT_LOCK_DETAIL,
  SEAT_LOCK_WAIT_MS,
  seatAccountingFrom,
  type SeatAccountingPort,
  type SeatLock,
  type SeatStripe,
} from './ports.js';
export {
  createReconcileSource,
  RECONCILE_BATCH,
  reconcileAll,
  type ReconcileRun,
  type ReconcileSource,
} from './reconcile.js';
export {
  DEFAULT_MAX_SEATS,
  SEAT_DETAILS,
  SeatService,
  seatsOf,
  type ReconcileResult,
  type SeatChangeContext,
  type SeatPreview,
  type SeatResult,
  type SeatServiceDeps,
} from './service.js';
