/**
 * `node dist/scan-stream.js <artefact>` (B101 surface 5): copies standard input to standard output unchanged
 * while the credential scanner reads the same bytes (`backupScanHook`). The backup script puts it between
 * `pg_dump` and the encryption, and the restore script between the decryption and `pg_restore`, so a database
 * that holds a provider credential is never uploaded or restored without notice.
 *
 * Exit codes: 0 clean; 3 a credential was found or the stream could not be read to the end (the artefact is
 * quarantined; the data was still copied through, the caller decides what to do with it); 2 usage. Standard
 * error carries counts and pattern ids, never the matched text.
 */
import { PassThrough } from 'node:stream';
import { secretGuard } from '@centcom/core';

async function main(): Promise<number> {
  const artefact = process.argv[2];
  if (artefact === undefined || !/^[A-Za-z0-9._/-]{1,120}$/.test(artefact)) {
    process.stderr.write('usage: scan-stream.js <artefact name>\n');
    return 2;
  }
  const tee = new PassThrough();
  const verdict = secretGuard.backupScanHook(tee, { artefact });
  process.stdin.on('data', (chunk: Buffer) => {
    tee.write(chunk);
    if (!process.stdout.write(chunk)) {
      process.stdin.pause();
      process.stdout.once('drain', () => process.stdin.resume());
    }
  });
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('end', resolve);
    process.stdin.once('error', reject);
  }).catch(() => undefined);
  tee.end();
  const result = await verdict;
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  if (result.quarantined) {
    process.stderr.write(
      `scan: ${artefact} quarantined (${result.reason ?? 'secret_found'}, ${result.hits} hits in ${result.scannedBytes} bytes)\n`,
    );
    return 3;
  }
  process.stderr.write(`scan: ${artefact} clean (${result.scannedBytes} bytes)\n`);
  return 0;
}

process.exitCode = await main();
