// @ts-check
/** B002 PR title check: only `B###: <summary>` passes. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLaneTitle } from './check-lane-title.mjs';

const script = join(import.meta.dirname, 'check-lane-title.mjs');
/** @param {string[]} args */
const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 });

describe('isLaneTitle', () => {
  it.each(['B037: relay service skeleton', 'B001: monorepo scaffold and toolchain', 'B100: x'])(
    'accepts %s',
    (t) => expect(isLaneTitle(t)).toBe(true),
  );

  it.each([
    'relay service skeleton',
    'b037: lowercase id',
    'B37: two digits',
    'B0371: four digits',
    'B037 relay (no colon)',
    'B037:no space',
    'B037: ',
    'C037: client lane',
    'feat(B037): conventional prefix',
    ' B037: leading space',
    '',
    undefined,
    42,
  ])('rejects %s', (t) => expect(isLaneTitle(t)).toBe(false));
});

describe('check-lane-title CLI', () => {
  it('exits 0 for a lane title', () => {
    expect(run('B037: relay service skeleton').status).toBe(0);
  });

  it('exits 1 and explains for any other title', () => {
    const r = run('Update README');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('B037: relay service skeleton');
  });

  it('exits 1 when no title is given', () => {
    expect(run().status).toBe(1);
  });
});
