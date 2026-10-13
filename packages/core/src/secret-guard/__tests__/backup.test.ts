/**
 * Surface 5, backups (B101): a key split across two windows is found once at the right offset, a
 * clean stream is clean, a read error is never "clean", and a 50 MiB stream scans in bounded
 * time and memory.
 */
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { backupScanHook, scanBackupStream } from '../backup.js';
import { AWS_KEY, ANTHROPIC_KEY } from '../../../test/secret-guard/helpers.js';

const stream = (chunks: (string | Buffer)[]): Readable =>
  Readable.from(chunks, { objectMode: false });

describe('scanBackupStream', () => {
  it('finds a key split across two 64 KiB windows, once, at the right offset', async () => {
    const window = 64 * 1024;
    const at = window - 7; // the key straddles the first window boundary
    const text = ' '.repeat(at) + AWS_KEY + ' '.repeat(window);
    const result = await scanBackupStream(stream([text.slice(0, window), text.slice(window)]));
    expect(result.hits).toEqual([{ pattern: 'aws_access_key', offset: at, length: 20 }]);
    expect(result.scannedBytes).toBe(text.length);
  });

  it('finds the same hit however the stream is chunked', async () => {
    const text = `${'a'.repeat(1_000)} ${ANTHROPIC_KEY} ${'b'.repeat(70_000)} ${AWS_KEY}`;
    const whole = await scanBackupStream(stream([text]));
    for (const size of [1, 7, 513, 4_096, 65_536, 200_000]) {
      const parts: string[] = [];
      for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
      const got = await scanBackupStream(stream(parts), { windowBytes: 4_096, overlapBytes: 600 });
      expect(got.hits, `chunks of ${size}`).toEqual(whole.hits);
    }
    expect(whole.hits.map((h) => h.pattern)).toEqual(['anthropic_api_key', 'aws_access_key']);
  });

  it('counts bytes, so offsets stay right after multi-byte text', async () => {
    const prefix = 'é€'; // 2 + 3 bytes in UTF-8
    const result = await scanBackupStream(stream([Buffer.from(`${prefix} ${AWS_KEY}`, 'utf8')]));
    expect(result.hits[0]?.offset).toBe(6);
  });

  it('scans 50 MiB in under 5 s with bounded memory', async () => {
    const line =
      '{"level":"info","service":"api","msg":"http.request","status":200,"duration_ms":7}\n';
    const chunk = Buffer.from(line.repeat(Math.ceil((1024 * 1024) / line.length)));
    let sent = 0;
    const total = 50 * 1024 * 1024;
    const source = new Readable({
      read() {
        if (sent >= total) {
          this.push(null);
          return;
        }
        sent += chunk.length;
        this.push(chunk);
      },
    });
    const before = process.memoryUsage().heapUsed + process.memoryUsage().external;
    let peak = 0;
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.external - before);
    }, 25);
    const started = performance.now();
    const result = await scanBackupStream(source);
    clearInterval(timer);
    expect(result.hits).toEqual([]);
    expect(result.scannedBytes).toBeGreaterThanOrEqual(total);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(peak).toBeLessThan(64 * 1024 * 1024);
  }, 30_000);
});

describe('backupScanHook', () => {
  it('quarantines a stream with a split key and reports one hit', async () => {
    const text = ' '.repeat(65_529) + AWS_KEY + ' '.repeat(100);
    const verdict = await backupScanHook(stream([text.slice(0, 65_536), text.slice(65_536)]), {
      artefact: 'db.dump',
    });
    expect(verdict).toMatchObject({ quarantined: true, hits: 1, reason: 'secret_found' });
  });

  it('passes a clean stream', async () => {
    expect(
      await backupScanHook(stream(['hello world '.repeat(10_000)]), { artefact: 'db.dump' }),
    ).toMatchObject({
      quarantined: false,
      hits: 0,
    });
  });

  it('never counts a stream that failed mid-scan as clean', async () => {
    const broken = new Readable({
      read() {
        this.push('fine text ');
        this.destroy(new Error('disk gone'));
      },
    });
    expect(await backupScanHook(broken, { artefact: 'db.dump' })).toMatchObject({
      quarantined: true,
      reason: 'scan_incomplete',
    });
  });
});
