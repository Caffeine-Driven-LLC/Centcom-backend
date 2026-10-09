/**
 * The log scrubber (B050; tests "privacy.logger.test.ts", acceptance 5, guardrail "deny by
 * default"): `ticket`, `ct`, `p`, `c`, `sig`, `text` and `path` are dropped at any depth up to 5,
 * at debug and trace too; circular objects never throw; child bindings are scrubbed; and every
 * field the relay's source logs (an AST scan of its log calls) is in the reviewed allowlist, so a
 * new one fails here until it is added.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LOG_FIELDS, NEVER_LOGGED } from '../../src/privacy/allowlists.js';
import { createRelayLogger, scrubFields } from '../../src/privacy/logger.js';
import { captureLogger } from '../helpers.js';

const FORBIDDEN = ['ticket', 'ct', 'p', 'c', 'sig', 'text', 'path'];
const SECRET = 'TOP-SECRET-VALUE';

describe('the scrubber (acceptance 5)', () => {
  it('drops forbidden keys at every depth up to 5, at every level', () => {
    const log = captureLogger();
    const relay = createRelayLogger(log.logger);
    const nest = (depth: number): Record<string, unknown> => {
      const level: Record<string, unknown> = Object.fromEntries(FORBIDDEN.map((k) => [k, SECRET]));
      level['reason'] = 'kept';
      if (depth > 0) level['state'] = nest(depth - 1);
      return level;
    };
    for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      relay[method](nest(5), `relay.${method}`);
    }
    const raw = log.raw();
    expect(raw).not.toContain(SECRET);
    expect(log.lines().filter((l) => l['reason'] === 'kept')).toHaveLength(6);
    for (const key of FORBIDDEN) expect(log.lines().some((l) => key in l)).toBe(false);
  });

  it('never throws on circular objects, and cuts them', () => {
    const log = captureLogger();
    const relay = createRelayLogger(log.logger);
    const a: Record<string, unknown> = { reason: 'loop' };
    a['state'] = a;
    expect(() => relay.info(a, 'relay.loop')).not.toThrow();
    expect(log.lines().at(-1)?.['reason']).toBe('loop');
    expect(scrubFields(a)).toEqual({ reason: 'loop' });
  });

  it('drops anything not allowlisted, keeps allowlisted fields, scrubs child bindings', () => {
    const log = captureLogger();
    const relay = createRelayLogger(log.logger).child({ sid: 'ses_x', frame: { ct: SECRET } });
    relay.info({ kind: 'reaction', count: 3, whatever: SECRET, note: SECRET }, 'relay.ok');
    const line = log.lines().at(-1);
    expect(line).toMatchObject({ kind: 'reaction', count: 3, sid: 'ses_x', msg: 'relay.ok' });
    expect(log.raw()).not.toContain(SECRET);
    relay.warn('relay.plain message');
    expect(log.lines().at(-1)?.['msg']).toBe('relay.plain message');
    expect(relay.isLevelEnabled('debug')).toBe(true);
  });

  it('never allowlists a forbidden key', () => {
    for (const key of [...FORBIDDEN, ...NEVER_LOGGED]) expect(LOG_FIELDS.has(key)).toBe(false);
  });
});

describe('the allowlist covers the relay’s own log calls', () => {
  it('every field logged under apps/relay/src is allowlisted (AST scan)', () => {
    const root = resolve(import.meta.dirname, '../../src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const used = new Map<string, string>();
    for (const file of files) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].includes(n.expression.name.text)
        ) {
          const first = n.arguments[0];
          if (first !== undefined && ts.isObjectLiteralExpression(first)) {
            for (const prop of first.properties) {
              const name = prop.name;
              if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
                used.set(name.text, file);
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(used.size).toBeGreaterThan(20);
    const missing = [...used].filter(([key]) => !LOG_FIELDS.has(key));
    expect(missing, 'log fields not in the reviewed allowlist (src/privacy/allowlists.ts)').toEqual(
      [],
    );
  });
});
