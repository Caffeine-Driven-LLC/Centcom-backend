/**
 * Surface 5, backups (B101): `scanBackupStream` reads a stream in windows and reports where the
 * provider credentials are, and `backupScanHook` is what the backup and restore tooling calls
 * before an upload completes and after a restore finishes. A hit, or a stream that could not be
 * read to the end, quarantines the artefact.
 *
 * Windows: each scan covers the last `overlapBytes` of the previous window plus new bytes; a match
 * that starts in the overlap is decided by the next window, so one split across two windows is
 * found once, at the right offset. Bytes are read as Latin-1, so offsets are byte offsets and no
 * multi-byte sequence can shift them. Memory is one window, however large the dump.
 *
 * Owns: streaming and offsets. Must not: keep matched bytes, report a partial scan as clean.
 */
import type { Logger } from '../log/logger.js';
import type { Metrics } from '../log/metrics.js';
import { guardMetrics } from './metrics.js';
import { scanTextRaw, type Hit } from './scan.js';

/** Default window and overlap (CT card: 64 KiB with a 512-byte overlap). */
export const DEFAULT_WINDOW_BYTES = 64 * 1024;
export const DEFAULT_OVERLAP_BYTES = 512;
/** After this many hits the scan stops: the artefact is quarantined anyway. */
export const MAX_BACKUP_HITS = 1_000;
/** The scan yields to the event loop after this many bytes. */
const YIELD_EVERY_BYTES = 256 * 1024;

/** Options of `scanBackupStream`. */
export interface BackupScanOptions {
  windowBytes?: number;
  overlapBytes?: number;
}

/** What `scanBackupStream` found. */
export interface BackupScan {
  scannedBytes: number;
  hits: Hit[];
  /** True when MAX_BACKUP_HITS was reached and the rest was not scanned. */
  truncated?: boolean;
}

/** Scans `readable` to the end. Rejects when the stream errors. */
export async function scanBackupStream(
  readable: NodeJS.ReadableStream,
  o: BackupScanOptions = {},
): Promise<BackupScan> {
  const window = Math.max(1_024, o.windowBytes ?? DEFAULT_WINDOW_BYTES);
  const overlap = Math.min(Math.max(0, o.overlapBytes ?? DEFAULT_OVERLAP_BYTES), window / 2);
  const hits: Hit[] = [];
  let carry = '';
  let carryStart = 0;
  let total = 0;
  let sinceYield = 0;
  let truncated = false;

  /** Scans carry + more; reports matches that start before the last `overlap` characters. */
  const scan = (more: string, final: boolean): void => {
    const text = carry + more;
    const decideBelow = final ? text.length : Math.max(0, text.length - overlap);
    for (const h of scanTextRaw(text)) {
      if (h.offset >= decideBelow) continue;
      if (hits.length >= MAX_BACKUP_HITS) {
        truncated = true;
        break;
      }
      hits.push({ pattern: h.pattern, offset: carryStart + h.offset, length: h.length });
    }
    carryStart += decideBelow;
    carry = text.slice(decideBelow);
  };

  for await (const chunk of readable) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Uint8Array);
    for (let at = 0; at < bytes.length && !truncated; at += window) {
      const slice = Buffer.from(
        bytes.buffer,
        bytes.byteOffset + at,
        Math.min(window, bytes.length - at),
      );
      scan(slice.toString('latin1'), false);
      total += slice.length;
      sinceYield += slice.length;
      if (sinceYield >= YIELD_EVERY_BYTES) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (truncated) break;
  }
  if (!truncated) scan('', true);
  return truncated ? { scannedBytes: total, hits, truncated } : { scannedBytes: total, hits };
}

/** Context for `backupScanHook`. */
export interface BackupScanContext {
  /** A name for the report: a file name or object key, never a secret. */
  artefact: string;
  metrics?: Metrics;
  logger?: Logger;
  windowBytes?: number;
  overlapBytes?: number;
}

/** The verdict the backup and restore drill acts on. */
export interface BackupVerdict {
  quarantined: boolean;
  hits: number;
  scannedBytes: number;
  /** `scan_incomplete` when the stream could not be read to the end. */
  reason?: 'secret_found' | 'scan_incomplete';
}

/** Scans a backup or restore stream; `quarantined` is true on a hit or when the scan did not finish. */
export async function backupScanHook(
  stream: NodeJS.ReadableStream,
  ctx: BackupScanContext,
): Promise<BackupVerdict> {
  const metrics = guardMetrics(ctx.metrics);
  const started = performance.now();
  try {
    const result = await scanBackupStream(stream, {
      ...(ctx.windowBytes === undefined ? {} : { windowBytes: ctx.windowBytes }),
      ...(ctx.overlapBytes === undefined ? {} : { overlapBytes: ctx.overlapBytes }),
    });
    metrics.scanned('backup', (performance.now() - started) / 1000);
    for (const h of result.hits) {
      metrics.hit('backup', h.pattern);
      ctx.logger?.warn(
        { surface: 'backup', pattern: h.pattern, artefact: ctx.artefact, offset: h.offset },
        'secret_guard_hit',
      );
    }
    return result.hits.length === 0
      ? { quarantined: false, hits: 0, scannedBytes: result.scannedBytes }
      : {
          quarantined: true,
          hits: result.hits.length,
          scannedBytes: result.scannedBytes,
          reason: 'secret_found',
        };
  } catch {
    ctx.logger?.warn({ surface: 'backup', artefact: ctx.artefact }, 'secret_guard_scan_incomplete');
    return { quarantined: true, hits: 0, scannedBytes: 0, reason: 'scan_incomplete' };
  }
}
