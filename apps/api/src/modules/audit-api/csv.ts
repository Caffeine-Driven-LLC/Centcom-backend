/**
 * Export file formats (B082): CSV (RFC 4180) and JSON, written one event at a time so an export is
 * streamed, never held whole.
 *
 * - CSV: a header line, then one line per event; every line ends in CRLF. A cell holding a comma,
 *   a quote, CR or LF is quoted, quotes doubled. Spreadsheet formula injection is neutralised: a
 *   cell beginning with `=`, `+`, `-` or `@` (or a tab or CR, which spreadsheets skip before
 *   reading a formula) is prefixed with `'`. `metadata` is its JSON text.
 * - JSON: an array of CT-API-AUDIT `AuditEvent`s, one per line.
 *
 * Owns: the bytes of an export file. Must not: write a cell unescaped.
 */
import type { AuditEventBody } from './present.js';

/** The CSV columns, in order. */
export const CSV_COLUMNS = Object.freeze([
  'id',
  'at',
  'workspace',
  'actor_type',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'result',
  'metadata',
] as const);

/** Characters that make a spreadsheet read a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** Characters that need a quoted cell. */
const NEEDS_QUOTES = /[",\r\n]/;

/** One CSV cell: formula-guarded, then quoted when it must be. */
export function csvCell(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** The header line. */
export const csvHeader = (): string => `${CSV_COLUMNS.join(',')}\r\n`;

/** One event as a CSV line. */
export function csvLine(event: AuditEventBody): string {
  const cells = [
    event.id,
    event.at,
    event.workspace,
    event.actor.type,
    event.actor.id ?? '',
    event.action,
    event.target?.type ?? '',
    event.target?.id ?? '',
    event.result ?? '',
    JSON.stringify(event.metadata ?? {}),
  ];
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** Writes a file of one format: its opening, each event, and its closing. */
export interface ExportWriter {
  readonly contentType: string;
  readonly extension: string;
  open(): string;
  event(event: AuditEventBody, index: number): string;
  close(): string;
}

/** The writer of `format`. */
export function exportWriter(format: 'csv' | 'json'): ExportWriter {
  if (format === 'csv') {
    return {
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
      open: csvHeader,
      event: (event) => csvLine(event),
      close: () => '',
    };
  }
  return {
    contentType: 'application/json',
    extension: 'json',
    open: () => '[',
    event: (event, index) => `${index === 0 ? '\n' : ',\n'}${JSON.stringify(event)}`,
    close: () => '\n]\n',
  };
}
