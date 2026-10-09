/**
 * Heartbeat scheduling cost (B040 acceptance 6), run in a child process by heartbeat.perf.test.ts
 * so the test runner's coverage does not distort it. Reads `{connections, simulatedMs}` from stdin,
 * welcomes that many idle connections that answer every ping, runs the heartbeat through
 * `simulatedMs` of fake time on its one platform timer, and prints the CPU it used with the pings
 * sent, the most platform timers ever armed, and the connections still open.
 */
import { readFileSync } from 'node:fs';
import { createHeartbeat } from '../../src/connection/heartbeat.js';
import type { ConnectionEntry } from '../../src/connection-registry.js';
import type { RelayConnection } from '../../src/pipeline.js';

const { connections, simulatedMs } = JSON.parse(readFileSync(0, 'utf8')) as {
  connections: number;
  simulatedMs: number;
};

let now = Date.parse('2026-01-01T00:00:00.000Z');
let timer: { fn: () => void; due: number } | undefined;
let armed = 0;
let maxArmed = 0;
const heartbeat = createHeartbeat({
  config: { pingMs: 20_000, deadMs: 50_000 },
  clock: () => now,
  monotonic: () => now,
  setTimer: (fn, ms) => {
    const t = { fn, due: now + ms };
    timer = t;
    armed += 1;
    maxArmed = Math.max(maxArmed, armed);
    return () => {
      if (timer === t) {
        timer = undefined;
        armed -= 1;
      }
    };
  },
  closeTimer: () => () => undefined,
});

let pings = 0;
const all: RelayConnection[] = [];
for (let i = 0; i < connections; i += 1) {
  const entry: ConnectionEntry = {
    id: `c${i}`,
    remoteHash: '0000000000000000',
    state: 'open',
    sessionId: null,
    memberId: null,
    deviceId: null,
    createdAt: new Date(now),
  };
  const connection: RelayConnection = {
    entry,
    send(frame) {
      // What the real connection does with a frame, then the peer's pong arriving.
      JSON.stringify(frame);
      if ((frame as { t?: string }).t === 'sys.ping') {
        pings += 1;
        heartbeat.machine(connection)?.touch();
      }
      return true;
    },
    close: () => undefined,
    terminate: () => undefined,
    onClose: () => undefined,
  };
  all.push(connection);
  heartbeat.onConnection(connection);
  await heartbeat.stage({ connection, raw: '{}', state: {} }, () => {
    entry.state = 'authenticated';
    return Promise.resolve();
  });
}

const end = now + simulatedMs;
const before = process.cpuUsage();
for (;;) {
  const t = timer;
  if (t === undefined || t.due > end) break;
  timer = undefined;
  armed -= 1;
  now = t.due;
  t.fn();
}
const used = process.cpuUsage(before);
process.stdout.write(
  JSON.stringify({
    cpuMs: (used.user + used.system) / 1_000,
    simulatedMs,
    pings,
    maxArmed,
    open: heartbeat.size,
    connections: all.length,
  }),
);
