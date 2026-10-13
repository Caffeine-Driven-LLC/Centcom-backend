/**
 * Speed and ReDoS (B101): 1 MiB of ordinary JSON log lines scans in about 50 microseconds per KiB
 * (the card's budget; 2x is reported as a warning, 5x fails, because CI machines vary), and
 * hostile 1 MiB inputs finish in seconds, not minutes: repeated `sk-`, `eyJ` (the JWT regex
 * backtracks quadratically, so the scanner walks it), key fragments and unterminated JSON fields.
 */
import { describe, expect, it } from 'vitest';
import { redactText } from '../redact.js';
import { scanText } from '../scan.js';
import { AWS_KEY } from '../../../test/secret-guard/helpers.js';

const MIB = 1024 * 1024;
const BUDGET_MS = 51;

function typicalLogLines(bytes: number): string {
  const line =
    '{"level":"info","time":"2026-10-13T16:01:57.607Z","service":"api","env":"production","request_id":"req_01M4V0AF0EYMC2K3ZCR94HJ5KG","method":"GET","route":"/v1/sessions/:id","status":200,"duration_ms":7,"bytes":1532,"msg":"http.request"}\n';
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

const time = (fn: () => unknown): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

describe('speed', () => {
  it('scans 1 MiB of typical log lines within the budget (2x warns, 5x fails)', () => {
    const text = typicalLogLines(MIB);
    scanText(text); // warm the regex engine
    const best = Math.min(...[1, 2, 3, 4, 5].map(() => time(() => scanText(text))));
    if (best > BUDGET_MS * 2) {
      process.stderr.write(
        `secret-guard perf warning: ${best.toFixed(1)} ms per MiB (budget ${BUDGET_MS})\n`,
      );
    }
    expect(best).toBeLessThan(BUDGET_MS * 5);
  });

  it('scans a typical line that mentions access_token without a secret just as fast', () => {
    const line = '{"msg":"refresh","access_token":"[redacted]","refresh_token":"[redacted]"}\n';
    const text = line.repeat(Math.ceil(MIB / line.length));
    scanText(text);
    expect(Math.min(...[1, 2, 3].map(() => time(() => scanText(text))))).toBeLessThan(
      BUDGET_MS * 10,
    );
  });
});

describe('hostile input, 1 MiB each, 10 s timeout', () => {
  const hostile: [string, string][] = [
    ['sk- repeated', 'sk-'.repeat(MIB / 3)],
    ['eyJ repeated', 'eyJ'.repeat(MIB / 3)],
    ['eyJ run ending in short segments', `${'eyJ'.repeat(MIB / 3)}.a.b`],
    ['eyJ with many dots', 'eyJaaaaaaaaaaaa.'.repeat(MIB / 16)],
    ['AKIA repeated', 'AKIA'.repeat(MIB / 4)],
    ['AKIA fragments', `${AWS_KEY.slice(0, 19)} `.repeat(MIB / 20)],
    ['AIza repeated', 'AIza'.repeat(MIB / 4)],
    [
      'unterminated access_token fields',
      ['"access_', 'token":"aaaaaaaaaaaaaaaaaaaaaaaa'].join('').repeat(MIB / 42),
    ],
    ['access_token then whitespace', `"access_token"${' '.repeat(MIB)}`],
    ['Authorization: Bearer repeated', 'Authorization: Bearer abc '.repeat(MIB / 26)],
    ['sk-ant- short tokens', 'sk-ant-abc '.repeat(MIB / 11)],
  ];
  it.each(hostile)(
    '%s',
    (_name, text) => {
      expect(text.length).toBeGreaterThan(MIB * 0.9);
      expect(time(() => scanText(text))).toBeLessThan(2_000);
      expect(time(() => redactText(text))).toBeLessThan(5_000);
    },
    10_000,
  );

  it('finds the one real key hidden in hostile padding', () => {
    const text = `${'eyJ'.repeat(100_000)}.a.b ${AWS_KEY} ${'sk-'.repeat(10)}`;
    expect(scanText(text).map((h) => h.pattern)).toContain('aws_access_key');
  }, 10_000);
});
