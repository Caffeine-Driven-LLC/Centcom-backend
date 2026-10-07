/**
 * List filters (B025, CT-PAGE): an endpoint declares its filters by query parameter (a string, an
 * enum, a CT-IDS id, a boolean, a timestamp range), and gets a parser and a stable hash. The hash
 * goes into every cursor, so a cursor only pages through the filters it was made for.
 *
 * Owns: reading declared filters from a query and hashing them. Must not: read parameters nobody
 * declared (they are ignored), or let a hash depend on parameter order or spelling of the same
 * value.
 */
import { createHash } from 'node:crypto';
import { hasControlChars, isId, type IdPrefix } from '@centcom/contracts';
import { validationFailed, type FieldError } from '../errors/app-error.js';
import { canonicalJson } from '../idempotency/fingerprint.js';
import { PAGINATION_DETAILS } from './query.js';

/** A parsed time range: `from` inclusive, `to` exclusive. */
export interface TimeRange {
  readonly from?: Date;
  readonly to?: Date;
}

/** One declared filter: reads its parameters, or reports what is wrong with them. */
export interface FilterDef<T> {
  /** The value of the filter `name` in `query`, undefined when absent; issues are pushed. */
  parse(
    query: Readonly<Record<string, unknown>>,
    name: string,
    issues: FieldError[],
  ): T | undefined;
}

/** The value a filter definition parses to. */
export type FilterValueOf<F> = F extends FilterDef<infer T> ? T : never;

/** The parsed filters of a definition set; absent filters are absent. */
export type FilterValues<S> = { -readonly [K in keyof S]?: FilterValueOf<S[K]> };

/** The longest string filter value by default. */
export const DEFAULT_MAX_FILTER_LENGTH = 200;
/** RFC 3339 date-times, as the contract's `format: date-time` parameters carry them. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;

/** The single string value of a parameter; repeated parameters are an issue. */
function single(
  query: Readonly<Record<string, unknown>>,
  param: string,
  issues: FieldError[],
): string | undefined {
  const value = query[param];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  issues.push({ pointer: `/${param}`, code: 'invalid_type', detail: 'must be given once' });
  return undefined;
}

/** A free-text filter: 1 to `maxLength` characters, without the control characters CT-IDS refuses. */
export function stringFilter(opts: { maxLength?: number } = {}): FilterDef<string> {
  const max = opts.maxLength ?? DEFAULT_MAX_FILTER_LENGTH;
  return {
    parse(query, name, issues) {
      const value = single(query, name, issues);
      if (value === undefined) return undefined;
      if (value.length === 0 || value.length > max || hasControlChars(value)) {
        issues.push({
          pointer: `/${name}`,
          code: 'invalid_format',
          detail: `must be 1 to ${max} printable characters`,
        });
        return undefined;
      }
      return value;
    },
  };
}

/** One of `values`. */
export function enumFilter<const T extends string>(values: readonly T[]): FilterDef<T> {
  return {
    parse(query, name, issues) {
      const value = single(query, name, issues);
      if (value === undefined) return undefined;
      if ((values as readonly string[]).includes(value)) return value as T;
      issues.push({
        pointer: `/${name}`,
        code: 'invalid_value',
        detail: `must be one of: ${values.join(', ')}`,
      });
      return undefined;
    },
  };
}

/** A CT-IDS id with `prefix`. */
export function idFilter(prefix: IdPrefix): FilterDef<string> {
  return {
    parse(query, name, issues) {
      const value = single(query, name, issues);
      if (value === undefined) return undefined;
      if (isId(prefix, value)) return value;
      issues.push({
        pointer: `/${name}`,
        code: 'invalid_format',
        detail: `must be a ${prefix}_ id`,
      });
      return undefined;
    },
  };
}

/** `true` or `false`. */
export function booleanFilter(): FilterDef<boolean> {
  return {
    parse(query, name, issues) {
      const value = single(query, name, issues);
      if (value === undefined) return undefined;
      if (value === 'true' || value === 'false') return value === 'true';
      issues.push({ pointer: `/${name}`, code: 'invalid_type', detail: 'must be true or false' });
      return undefined;
    },
  };
}

/**
 * A time range from two RFC 3339 parameters: `from` (inclusive) and `to` (exclusive), named
 * `<filter>_from` and `<filter>_to` unless given (the audit log's are plain `from` and `to`).
 */
export function rangeFilter(params: { from?: string; to?: string } = {}): FilterDef<TimeRange> {
  return {
    parse(query, name, issues) {
      const names = { from: params.from ?? `${name}_from`, to: params.to ?? `${name}_to` };
      const read = (which: 'from' | 'to'): Date | undefined => {
        const value = single(query, names[which], issues);
        if (value === undefined) return undefined;
        const time = DATE_TIME.test(value) ? Date.parse(value) : NaN;
        if (!Number.isNaN(time)) return new Date(time);
        issues.push({
          pointer: `/${names[which]}`,
          code: 'invalid_format',
          detail: 'must be an RFC 3339 date-time',
        });
        return undefined;
      };
      const from = read('from');
      const to = read('to');
      if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
        issues.push({
          pointer: `/${names.to}`,
          code: 'out_of_range',
          detail: 'must be after the start',
        });
        return undefined;
      }
      if (from === undefined && to === undefined) return undefined;
      return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
    },
  };
}

/** An endpoint's filters: a parser and the hash cursors are bound to. */
export interface Filters<S> {
  /** The declared filters in `query`; undeclared parameters are ignored. Throws a 422 listing every bad one. */
  parse(query: unknown): FilterValues<S>;
  /** `sha256:<hex>` of the parsed filters: the same filters give the same hash, whatever their order. */
  hash(filters: FilterValues<S>): string;
}

/** Declares an endpoint's filters, by query parameter name. */
export function defineFilters<S extends Readonly<Record<string, FilterDef<unknown>>>>(
  definitions: S,
): Filters<S> {
  return {
    parse(query) {
      const source =
        typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
      const issues: FieldError[] = [];
      const values: Record<string, unknown> = {};
      for (const [name, definition] of Object.entries(definitions)) {
        const value = definition.parse(source, name, issues);
        if (value !== undefined) values[name] = value;
      }
      if (issues.length > 0) throw validationFailed(issues, PAGINATION_DETAILS.invalidQuery);
      return values as FilterValues<S>;
    },
    hash(filters) {
      // Dates hash by their instant, so `...Z` and `...+00:00` are one filter.
      const plain = JSON.parse(JSON.stringify(filters)) as unknown;
      return `sha256:${createHash('sha256').update(canonicalJson(plain), 'utf8').digest('hex')}`;
    },
  };
}
