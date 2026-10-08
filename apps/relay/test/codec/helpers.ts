/**
 * Test helpers for the codec (B039): the event fixtures of contracts/fixtures/events/, frames of an
 * exact byte size, nested JSON of a given depth, and a relay whose connections are authenticated
 * at once (standing in for B038's handshake) with the decode stage and a recording stage after it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCodecStage, type CodecStageDeps } from '../../src/codec/stage.js';
import type { RelayModule } from '../../src/modules.js';
import { connect, testRelay, type Client, type TestRelay } from '../helpers.js';

const EVENTS = resolve(import.meta.dirname, '../../../../contracts/fixtures/events');

/** The session every fixture frame names. */
export const FIXTURE_SID = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

/** Every event fixture: its kind and frame (as the server would send it, with from/ts/seq). */
export function eventFixtures(): { kind: string; frame: Record<string, unknown> }[] {
  return readdirSync(EVENTS)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const data = JSON.parse(readFileSync(resolve(EVENTS, f), 'utf8')) as {
        kind: string;
        frame: Record<string, unknown>;
      };
      return { kind: data.kind, frame: data.frame };
    });
}

/** An unknown-kind event whose JSON is exactly `bytes` long (ASCII padding in `p.pad`). */
export function frameOfBytes(bytes: number, sid = FIXTURE_SID): string {
  const base = {
    v: 1,
    t: 'event',
    id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    sid,
    k: 'future.kind',
    p: { pad: '' },
  };
  const empty = JSON.stringify(base).length;
  return JSON.stringify({ ...base, p: { pad: 'a'.repeat(bytes - empty) } });
}

/** An event whose JSON nests `depth` levels deep, the frame itself included (depth >= 2). */
export function nestedFrame(depth: number, sid = FIXTURE_SID): string {
  // The frame is level 1 and `p` level 2; each `n` adds one.
  let p: Record<string, unknown> = {};
  for (let i = 0; i < depth - 2; i += 1) p = { n: p };
  return JSON.stringify({
    v: 1,
    t: 'event',
    id: 'msg_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    sid,
    k: 'future.kind',
    p,
  });
}

/** A relay with connections authenticated on arrival, the decode stage, and a recorder at 50. */
export async function codecRelay(
  deps: CodecStageDeps = {},
  sid = FIXTURE_SID,
): Promise<{
  relay: TestRelay;
  passed: unknown[];
  open(): Client;
}> {
  const passed: unknown[] = [];
  const module: RelayModule = {
    name: 'codec-test',
    order: 10,
    register(ctx) {
      ctx.pipeline.use(10, createCodecStage({ logger: ctx.log, metrics: ctx.metrics, ...deps }));
      ctx.pipeline.use(50, async (fc) => {
        passed.push(fc.frame);
      });
      ctx.onConnection((connection) => {
        connection.entry.state = 'authenticated';
        connection.entry.sessionId = sid;
      });
      return undefined;
    },
  };
  const relay = await testRelay({ modules: [module] });
  return { relay, passed, open: () => connect(relay.url) };
}
