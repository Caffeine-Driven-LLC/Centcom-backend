/**
 * Member slots (B031): the slot service the relay's join and roster code use (B038, B043, B044).
 */
export {
  createSlotService,
  MAX_SESSION_MEMBERS,
  SessionNotFoundError,
  SLOT_ASSIGN_ATTEMPTS,
  SlotsExhaustedError,
  type SlotService,
} from './service.js';
