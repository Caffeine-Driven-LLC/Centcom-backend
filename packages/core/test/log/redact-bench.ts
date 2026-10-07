/**
 * Times redact() on a 1 MB object (B005 acceptance 7). redact.test.ts runs this in a separate
 * Node process: test workers run under coverage instrumentation, which slows this code several
 * times over, and share the CPU with other test files, so a timing taken there would measure
 * those instead. Writes `{ bytes, bestMs }` as JSON to stdout.
 */
import { performance } from 'node:perf_hooks';
import { redact } from '../../src/log/redact.js';
import { megabyteObject } from './helpers.js';

const RUNS = 10;
const input = megabyteObject();
redact(input); // warm-up, so the timing measures redaction, not JIT compilation
let bestMs = Number.POSITIVE_INFINITY;
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  redact(input);
  bestMs = Math.min(bestMs, performance.now() - started);
}
process.stdout.write(JSON.stringify({ bytes: JSON.stringify(input).length, bestMs }));
