/**
 * Metadata search (B089): staff search over session, workspace, user and member names and ids,
 * never content. See README.md and docs/platform/metadata-search.md.
 */
export { searchForMember, searchPlugin, type SearchPluginOptions } from './plugin.js';
export {
  DEFAULT_SEARCH_LIMIT,
  escapeLike,
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_LENGTH,
  normaliseQuery,
  parseLimit,
  parseTypes,
  SEARCH_TYPES,
  SEARCHABLE_COLUMNS,
  type NormalisedQuery,
  type SearchType,
} from './query.js';
export {
  assertSearchReady,
  buildSearchQuery,
  SEARCH_TIMEOUT,
  searchMetadata,
  type SearchDeps,
  type SearchHit,
  type SearchInput,
  type SearchPage,
  type SearchScope,
} from './service.js';
