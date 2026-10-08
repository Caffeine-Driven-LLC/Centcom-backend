/**
 * Entry points (B011 guardrail): the simulator, LoopbackRelay included, is reached through
 * `@centcom/testkit/sim` only; the package root exports none of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as root from '../../src/index.js';
import * as sim from '../../src/sim/index.js';

describe('entry points', () => {
  it('keeps LoopbackRelay and the simulator out of the package root', () => {
    expect(sim.LoopbackRelay).toBeDefined();
    expect(sim.SimClient).toBeDefined();
    for (const name of Object.keys(sim)) expect(Object.keys(root), name).not.toContain(name);
  });

  it('publishes the simulator as the ./sim subpath', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, { default: string }>;
    };
    expect(pkg.exports['./sim']?.default).toBe('./dist/sim/index.js');
  });
});
