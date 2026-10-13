/**
 * A load generator process (B095), forked by relay-load.ts: at most MAX_CONNECTIONS_PER_PROCESS
 * clients each, so no process saturates itself. It takes commands over IPC and answers with
 * counters; it holds no secret and sends only synthetic, random-byte frames.
 */
import { testJwks } from '@centcom/testkit/sim';
import { Population } from './population.js';
import { Seeder } from './seed.js';
import { LagMonitor } from './stats.js';

type Command =
  | { t: 'init'; databaseUrl: string; members: number }
  | { t: 'start'; urls: string[] }
  | { t: 'grow'; count: number }
  | { t: 'send'; fps: number }
  | { t: 'stop-send' }
  | { t: 'window' }
  | { t: 'collect' }
  | { t: 'loss' }
  | { t: 'storm'; on: boolean }
  | { t: 'resumes'; crashAt: number }
  | { t: 'close' };

let pop: Population | undefined;
let seeder: Seeder | undefined;
let members = 5;
const lag = new LagMonitor();
let windowSent = 0;
let windowDelivered = 0;
let windowCloses = 0;

const reply = (id: number, body: object): void => {
  process.send?.({ id, ...body });
};

process.on('message', (msg: Command & { id: number }) => {
  void (async () => {
    try {
      switch (msg.t) {
        case 'init':
          seeder = await Seeder.create(msg.databaseUrl);
          members = msg.members;
          reply(msg.id, { jwks: testJwks() });
          return;
        case 'start':
          if (seeder === undefined) throw new Error('not initialised');
          pop = new Population(msg.urls, members, seeder);
          lag.start();
          reply(msg.id, {});
          return;
        case 'grow':
          await pop?.grow(msg.count);
          reply(msg.id, {
            connections: pop?.connections ?? 0,
            failures: pop?.connectFailures ?? 0,
            retries: pop?.retries ?? 0,
            errors: Object.fromEntries(pop?.connectErrors ?? []),
          });
          return;
        case 'send':
          pop?.startSending(msg.fps);
          reply(msg.id, {});
          return;
        case 'stop-send':
          pop?.stopSending();
          reply(msg.id, {});
          return;
        case 'window':
          pop?.latency.reset();
          lag.lag.reset();
          windowSent = pop?.totalSent() ?? 0;
          windowDelivered = pop?.totalDelivered() ?? 0;
          windowCloses = pop?.unexpectedCloses ?? 0;
          reply(msg.id, {});
          return;
        case 'collect': {
          const lagSamples = lag.lag;
          reply(msg.id, {
            connections: pop?.connections ?? 0,
            sent: (pop?.totalSent() ?? 0) - windowSent,
            delivered: (pop?.totalDelivered() ?? 0) - windowDelivered,
            closes: (pop?.unexpectedCloses ?? 0) - windowCloses,
            hist: pop?.latency.toJSON(),
            lagP99: lagSamples.percentile(99),
            sessions: pop?.sessions.length ?? 0,
          });
          return;
        }
        case 'loss':
          reply(msg.id, { loss: pop?.lossCheck(), states: pop?.resumeStates() });
          return;
        case 'storm':
          if (pop !== undefined) pop.stormMode = msg.on;
          reply(msg.id, {});
          return;
        case 'resumes':
          reply(msg.id, { seconds: pop?.resumeSeconds(msg.crashAt) ?? [] });
          return;
        case 'close':
          pop?.closeAll();
          lag.stop();
          await new Promise((r) => setTimeout(r, 300));
          await seeder?.close();
          reply(msg.id, {});
          process.exit(0);
      }
    } catch (err) {
      reply(msg.id, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

process.send?.({ id: 0, ready: true });
