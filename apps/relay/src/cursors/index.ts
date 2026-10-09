/**
 * Cursors and typing (B048, CT-WS-PRESENCE): the latest cursor per member, at most 10 a second in
 * and one per 100 ms out, and typing indicators cleared after 5 s. The relay module is `module.ts`
 * (order 36).
 */
export {
  cursorsEnvSchema,
  DEFAULT_CURSOR_IN_PER_S,
  DEFAULT_CURSOR_MAX_CT_BYTES,
  DEFAULT_CURSOR_TICK_MS,
  DEFAULT_TYPING_TTL_MS,
  loadCursorsConfig,
  type CursorsConfig,
} from './config.js';
export { createCursorsModule } from './module.js';
export { CURSOR_TOO_LARGE_DETAIL, cursorStage } from './stage.js';
export {
  createCursorThrottle,
  FLOOD_FACTOR,
  FLOOD_SECONDS,
  PRESENCE_CURSOR,
  SLOT_IDLE_MS,
  type CursorThrottle,
  type CursorThrottleDeps,
  type CursorTimer,
  type PresenceCursorFrame,
} from './throttle.js';
export { createTypingTracker, type TypingTimer, type TypingTracker } from './typing.js';
