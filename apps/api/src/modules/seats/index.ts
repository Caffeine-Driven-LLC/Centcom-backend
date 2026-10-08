/**
 * Seats (B030): counting a workspace's seats and the gate that enforces `max_seats` when members
 * are added. B029's invite routes need the `seatGate` decorator (`seatGatePlugin`); B069 can add
 * `usage.seats` with `withSeatUsage`; billing (B073) reads `getSeatUsage`.
 */
export {
  createSeatGate,
  lockWorkspaceSeats,
  SEAT_DETAILS,
  SEAT_LOCK_RETRY_AFTER_S,
  SEAT_LOCK_TIMEOUT_MS,
  seatGatePlugin,
  seatLimitsFrom,
  type SeatGateDeps,
  type SeatLimitReader,
} from './gate.js';
export {
  getSeatUsage,
  SEAT_COUNTED_ROLES,
  SeatService,
  seatUsageQuery,
  withSeatUsage,
  type SeatDb,
  type SeatServiceDeps,
  type SeatUsage,
} from './service.js';
