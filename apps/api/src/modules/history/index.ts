/**
 * The durable history store (B055, CT-RESUME): the service behind `routes/history`, plus the
 * store, its blob stores and the writer, which live in `@centcom/storage` (shared with the relay,
 * B042) and are re-exported here.
 */
export * from '@centcom/storage';
export {
  createPostgresHistoryAccess,
  HISTORY_DETAILS,
  HistoryService,
  mayRead,
  type AccessDatabase,
  type HistoryCaller,
  type HistoryServiceDeps,
} from './service.js';
