/**
 * The audit log's filters (B082, CT-API-AUDIT), for the list's query and an export's body alike:
 *
 * - `actor`: a `usr_`, `key_` or `dev_` id (CT-IDS); anything else is 422 at `/actor`;
 * - `action`: an exact action name, at most 64 characters. A name nobody wrote matches nothing, so
 *   an unknown action is an empty page, never an error;
 * - `from`, `to`: RFC 3339 date-times, `from` inclusive and `to` exclusive. `from` after `to` is
 *   422 at `/from`.
 *
 * They combine with AND. List cursors are bound to the workspace and the filters (`listFilterHash`),
 * so a cursor from another filter set or workspace is a 400 `cursor_invalid`.
 *
 * Owns: reading and hashing filters. Must not: accept a filter value it cannot check.
 */
import { isId, validate } from '@centcom/contracts';
import {
  defineFilters,
  idFilter,
  MAX_AUDIT_ACTION_LENGTH,
  stringFilter,
  validationFailed,
  type FieldError,
  type FilterDef,
  type TimeRange,
} from '@centcom/core';

/** The filters of a list or an export; absent ones are absent. */
export interface AuditFilters {
  actor?: string;
  action?: string;
  range?: TimeRange;
}

/** An export request: a format, filters, and whether the file is gzipped. */
export interface ExportRequest {
  format: 'csv' | 'json';
  gzip: boolean;
  filters: AuditFilters;
}

/** The details of refusals (GUIDELINES §3.4). */
export const FILTER_DETAILS = Object.freeze({
  invalid: 'The filters are not valid.',
  invalidBody: 'The export request is not valid.',
} as const);

/** The id kinds an actor filter may name. */
const ACTOR_PREFIXES = ['usr', 'key', 'dev'] as const;
/** RFC 3339 date-times, as the contract's `format: date-time` parameters carry them. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;

/** A `usr_`, `key_` or `dev_` id, given once. */
function actorFilter(): FilterDef<string> {
  return {
    parse(query, name, issues) {
      const value = query[name];
      if (value === undefined) return undefined;
      if (typeof value === 'string' && ACTOR_PREFIXES.some((prefix) => isId(prefix, value))) {
        return value;
      }
      issues.push({
        pointer: `/${name}`,
        code: 'invalid_format',
        detail: 'must be a usr_, key_ or dev_ id',
      });
      return undefined;
    },
  };
}

/** `from` (inclusive) and `to` (exclusive); `from` after `to` is reported at `/from`. */
function rangeOf(): FilterDef<TimeRange> {
  return {
    parse(query, _name, issues) {
      const read = (param: 'from' | 'to'): Date | undefined => {
        const value = query[param];
        if (value === undefined) return undefined;
        const time = typeof value === 'string' && DATE_TIME.test(value) ? Date.parse(value) : NaN;
        if (!Number.isNaN(time)) return new Date(time);
        issues.push({
          pointer: `/${param}`,
          code: 'invalid_format',
          detail: 'must be an RFC 3339 date-time',
        });
        return undefined;
      };
      const from = read('from');
      const to = read('to');
      if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
        issues.push({ pointer: '/from', code: 'out_of_range', detail: 'must not be after to' });
        return undefined;
      }
      if (from === undefined && to === undefined) return undefined;
      return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
    },
  };
}

const DEFINITIONS = {
  actor: actorFilter(),
  action: stringFilter({ maxLength: MAX_AUDIT_ACTION_LENGTH }),
  range: rangeOf(),
};
const FILTERS = defineFilters(DEFINITIONS);
/** What a list cursor is bound to: the workspace and the filters. */
const CURSOR_SCOPE = defineFilters({ workspace: idFilter('wsp'), ...DEFINITIONS });

/** The filters in a list query; a 422 listing every bad one. Other parameters are ignored. */
export function parseListFilters(query: unknown): AuditFilters {
  return FILTERS.parse(query);
}

/** The hash a list cursor of `workspaceId` with `filters` carries. */
export function listFilterHash(workspaceId: string, filters: AuditFilters): string {
  return CURSOR_SCOPE.hash({ workspace: workspaceId, ...filters });
}

/** Which filters are set, by parameter name, in a stable order (for the audit event's meta). */
export function filterNames(filters: AuditFilters): string[] {
  const names: string[] = [];
  if (filters.actor !== undefined) names.push('actor');
  if (filters.action !== undefined) names.push('action');
  if (filters.range?.from !== undefined) names.push('from');
  if (filters.range?.to !== undefined) names.push('to');
  return names;
}

/**
 * An export request body (CT-API-AUDIT `AuditExportCreate`): `format` and the filters, plus an
 * optional `gzip` flag (default false). A 422 lists every problem.
 */
export function parseExportBody(body: unknown): ExportRequest {
  const checked = validate('api/AuditExportCreate', body);
  const issues: FieldError[] = checked.ok ? [] : [...checked.errors];
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const gzip = record['gzip'];
  if (gzip !== undefined && typeof gzip !== 'boolean') {
    issues.push({ pointer: '/gzip', code: 'invalid_type', detail: 'must be a boolean' });
  }
  let filters: AuditFilters = {};
  try {
    filters = FILTERS.parse(record);
  } catch (err) {
    const errors = (err as { errors?: readonly FieldError[] }).errors ?? [];
    for (const error of errors) {
      if (!issues.some((issue) => issue.pointer === error.pointer)) issues.push(error);
    }
  }
  if (issues.length > 0) throw validationFailed(issues, FILTER_DETAILS.invalidBody);
  return {
    format: record['format'] === 'json' ? 'json' : 'csv',
    gzip: gzip === true,
    filters,
  };
}
