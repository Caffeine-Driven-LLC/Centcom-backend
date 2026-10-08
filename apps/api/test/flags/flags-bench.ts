/**
 * Times `GET /v1/flags` with 500 flags in the cache (B083 acceptance 6: p95 ≤ 20 ms, body ≤ 64 KiB).
 * flags.perf.test.ts runs this in a separate Node process (tsx's CLI with tsconfig.test.json, so no
 * build is needed): test workers run under coverage instrumentation and share their thread with
 * other test files. The flags mix every type and rule. After a warm-up, three rounds of 200
 * requests by a user token; writes `{p95s, bytes, flags, loads}` as JSON to stdout (`loads`: reads
 * of the repository during the timed rounds).
 */
import { performance } from 'node:perf_hooks';
import { newId } from '@centcom/contracts';
import { boolFlag, flagsWorld, getFlags, staff } from './helpers.js';

const ROUNDS = 3;
const PER_ROUND = 200;

const world = flagsWorld();
const { app, admin } = await world.instance();
const ws = newId('wsp');
for (let i = 0; i < 500; i += 1) {
  const key = `bench.flag_${String(i).padStart(3, '0')}`;
  const kind = i % 5;
  if (kind === 0) await admin.setFlag(boolFlag(key, { public: true }), staff);
  else if (kind === 1)
    await admin.setFlag(boolFlag(key, { rules: [{ type: 'percent', percent: 30 }] }), staff);
  else if (kind === 2)
    await admin.setFlag(
      boolFlag(key, {
        rules: [
          { type: 'plans', plans: ['pro', 'team'] },
          { type: 'workspaces', workspaces: [ws] },
        ],
      }),
      staff,
    );
  else if (kind === 3)
    await admin.setFlag(
      {
        key,
        type: 'number',
        value: i,
        default: 0,
        rules: [{ type: 'client_version', min: '1.2.0' }],
      },
      staff,
    );
  else
    await admin.setFlag(
      { key, type: 'json', value: { limit: i, mode: 'fast' }, default: { limit: 1, mode: 'safe' } },
      staff,
    );
}
const headers = {
  ...(await world.userToken({ plan: 'pro', workspaceId: ws })),
  'user-agent': 'centcom-cli/1.4.2 (contract/1.0.0; linux-x64; node/22.9.0)',
};
for (let i = 0; i < 50; i += 1) await getFlags(app, headers);
const loadsBefore = world.repo.loads;
const p95s: number[] = [];
let bytes = 0;
let flags = 0;
for (let round = 0; round < ROUNDS; round += 1) {
  const samples: number[] = [];
  for (let i = 0; i < PER_ROUND; i += 1) {
    const started = performance.now();
    const res = await getFlags(app, headers);
    samples.push(performance.now() - started);
    if (res.statusCode !== 200) throw new Error(`status ${res.statusCode}`);
    bytes = Buffer.byteLength(res.body);
    flags = Object.keys(res.json<{ flags: object }>().flags).length;
  }
  samples.sort((a, b) => a - b);
  p95s.push(samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY);
}
const loads = world.repo.loads - loadsBefore;
await world.close();
process.stdout.write(JSON.stringify({ p95s, bytes, flags, loads }));
