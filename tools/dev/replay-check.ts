/**
 * `pnpm dev:replay-check` (B107): the relay's durable log survives the relay. A host talks in a
 * session, the relay is stopped and started again (its memory is gone; only the history bucket in
 * MinIO is left), the host's client reconnects and talks again, and the sequence numbers go on from
 * where they were instead of starting over; the history route then reads one unbroken log.
 *
 * Needs `pnpm dev:up`, `pnpm dev:api` and `pnpm dev:relay` running (this script restarts the
 * relay: it stops what listens on the relay's port and starts `pnpm dev:relay` again, detached).
 * Exits 1 when a step failed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { api, listen, signUp, until, type Person } from './client-kit.js';

const step = (text: string): void => console.log(`\n== ${text}`);
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const relayPort =
  new URL(process.env['RELAY_PUBLIC_URL'] ?? 'ws://localhost:8088/v1/ws').port || '8088';

const pidsOnPort = (): number[] => {
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${relayPort}`], { encoding: 'utf8' });
    return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
};

async function history(who: Person, sid: string): Promise<{ seq: number }[]> {
  const res = await fetch(`${api}/v1/sessions/${sid}/history?after_seq=0`, {
    headers: { authorization: `Bearer ${who.token}` },
  });
  return ((await res.json()) as { data: { seq: number }[] }).data;
}

step('A host talks, then the relay restarts');
const alice = await signUp('replay');
const list = await fetch(`${api}/v1/workspaces`, {
  headers: { authorization: `Bearer ${alice.token}` },
});
const ws = ((await list.json()) as { data: { id: string }[] }).data[0]?.id ?? '';
const seqs: number[] = [];
const log: string[] = [];
const host = await alice.sessions.createSession({ name: 'replay check', workspace: ws });
listen(host, log, 'alice');
host.onAny((e: { seq: number }) => seqs.push(e.seq));
for (const text of ['one', 'two', 'three'])
  await host.sendEvent('message.user', { secret: { text } });
check(await until(() => log.length === 3, 5_000), 'three messages went through the relay');
await sleep(5_000); // the writer flushes its batch to the object store within a few seconds
const before = await history(alice, host.id);
const last = Math.max(...before.map((f) => f.seq));
check(
  before.length >= 3,
  `the history holds ${before.length} frames (up to seq ${last}) before the restart`,
);

for (const pid of pidsOnPort()) process.kill(pid, 'SIGTERM');
await until(() => pidsOnPort().length === 0, 15_000);
const out = openSync('/tmp/dev-relay-restart.log', 'a');
spawn('pnpm', ['dev:relay'], { detached: true, stdio: ['ignore', out, out] }).unref();
check(await until(() => pidsOnPort().length > 0, 40_000), 'the relay is back (its memory is gone)');

step('The host reconnects; the numbers go on');
check(await until(() => host.state === 'live', 60_000), 'the host client reconnected');
const mark = seqs.length;
await host.sendEvent('message.user', { secret: { text: 'after the restart' } });
check(await until(() => seqs.length > mark, 10_000), 'the host got its new message back');
const next = seqs.at(-1) ?? 0;
check(
  next > last,
  `the new frame is seq ${next}, after ${last}: the log was loaded from the object store, not started over`,
);
await sleep(5_000);
const after = await history(alice, host.id);
const nums = after.map((f) => f.seq).sort((a, b) => a - b);
check(
  nums.every((n, i) => i === 0 || n === (nums[i - 1] ?? 0) + 1),
  `the history is one unbroken log across the restart (${nums.join(', ')})`,
);

await host.end();
console.log(process.exitCode === 1 ? '\nFAILED' : '\nOK: the durable log survives the relay');
process.exit(process.exitCode ?? 0);
