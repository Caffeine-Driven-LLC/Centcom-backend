/**
 * The canary harness (B050, card `privacyCanaryRun`): drives a running relay through every event
 * kind a client may send, with a unique canary in `ct.c` and in every secret field and an extra
 * `p.note`, then scans everything the relay keeps or emits outside ciphertext for it: the log (at
 * trace level), metric labels, the hot buffer and the durable log (frames without `ct`), error
 * frames, and the clear parts other members receive. It also confirms the canary did travel inside
 * `ct` (so a run that sent nothing cannot pass).
 *
 * `privacyRelay()` builds the relay: B011 SimClients against the codec, handshake, privacy gate
 * (B050), presence (B047, in memory), cursors (B048), sequencing (B041, with the durable port
 * captured), resume, fan-out and the cluster node; `extra` adds modules (the negative controls).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { EVENT_KINDS, newId } from '@centcom/contracts';
import type { SimClient } from '@centcom/testkit/sim';
import { createCursorsModule } from '../../src/cursors/module.js';
import type { RelayModule } from '../../src/modules.js';
import { createPresence } from '../../src/presence/service.js';
import { presenceStage } from '../../src/presence/stage.js';
import { createMemoryPresenceStore } from '../../src/presence/store.js';
import privacyModule from '../../src/privacy/module.js';
import { KIND_MIN_ROLE } from '../../src/rooms/kind-policy.js';
import type { RoomRegistry } from '../../src/rooms/registry.js';
import { SEQUENCED_TYPES, type StoredFrame } from '../../src/seq/types.js';
import { cluster } from '../cluster/helpers.js';

const FIXTURES = new URL('../../../../contracts/fixtures/events/', import.meta.url);
const fixtures = new Map(
  readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const d = JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8')) as {
        kind: string;
        frame: Record<string, unknown>;
        secret_payload: Record<string, unknown> | null;
      };
      return [d.kind, d] as const;
    }),
);

/** The relay under test, and what to scan. */
export interface RelayTestHarness {
  sid: string;
  client(): Promise<SimClient>;
  logs(): string;
  metricSeries(): unknown;
  buffered(): Promise<StoredFrame[]>;
  durable(): StoredFrame[];
  stop(): Promise<void>;
}

/** A running relay for the canary run; `extra` modules are added (negative controls). */
export async function privacyRelay(extra: RelayModule[] = []): Promise<RelayTestHarness> {
  // The node's rooms, once it runs (the presence module registers before).
  const holder: { rooms?: RoomRegistry } = {};
  const presenceModule: RelayModule = {
    name: 'presence',
    order: 35,
    register(ctx) {
      const presence = createPresence({
        store: createMemoryPresenceStore(),
        rooms: { get: (sid) => holder.rooms?.get(sid) },
        config: { inMs: 0, outMs: 0, offlineGraceMs: 10_000 },
        nodeId: () => 'node-a',
        logger: ctx.log,
        metrics: ctx.metrics,
      });
      ctx.pipeline.use(35, presenceStage({ service: presence, metrics: ctx.metrics }));
      ctx.presence = presence;
      return undefined;
    },
  };
  const c = await cluster(1, {
    modules: () => [privacyModule, presenceModule, createCursorsModule({}), ...extra],
  });
  const node = c.nodes[0];
  if (node === undefined) throw new Error('no node');
  holder.rooms = node.rooms;
  return {
    sid: c.sid,
    client: () => c.client(node, c.member({ role: 'host' })),
    logs: () => node.relay.log.raw(),
    metricSeries: () => [...node.relay.recorded.series(), ...node.metrics.series()],
    buffered: () => c.store.range(c.sid, 0, 1_000),
    durable: () => c.log.frames(c.sid),
    stop: () => c.stop(),
  };
}

const withoutCt = (frame: Record<string, unknown>): Record<string, unknown> => {
  const copy = { ...frame };
  delete copy['ct'];
  return copy;
};

/** A canary that is valid base64url (it travels inside `ct.c` too). */
export const newCanary = (): string => `CANARY${newId('req').slice(4).toLowerCase()}`;

/** The card's run: every client kind with the canary; the leaks found. */
export async function privacyCanaryRun(opts: {
  relay: RelayTestHarness;
  canary?: string;
}): Promise<{ leaks: { where: string; sample: string }[]; kinds: number; idLabels: boolean }> {
  const canary = opts.canary ?? newCanary();
  const { relay } = opts;
  const sender = await relay.client();
  const observer = await relay.client();
  let sequenced = 0;
  let kinds = 0;
  for (const kind of EVENT_KINDS) {
    // Server-only kinds: no client may send them (B043 refuses them).
    if ((KIND_MIN_ROLE[kind] ?? []).length === 0) continue;
    const fixture = fixtures.get(kind);
    if (fixture === undefined) throw new Error(`no fixture for ${kind}`);
    const f = fixture.frame;
    const frame: Record<string, unknown> = {
      v: 1,
      t: f['t'],
      id: newId('msg'),
      sid: relay.sid,
      k: kind,
    };
    if (f['p'] !== undefined) {
      const secret = Object.fromEntries(
        Object.keys(fixture.secret_payload ?? {}).map((key) => [key, canary]),
      );
      frame['p'] = { ...(f['p'] as object), ...secret, note: canary };
    }
    if (f['ct'] !== undefined) {
      frame['ct'] = { ...(f['ct'] as object), c: `${canary}${'A'.repeat(16)}` };
      frame['sig'] = f['sig'];
    }
    sender.sendRaw(JSON.stringify(frame));
    kinds += 1;
    if (SEQUENCED_TYPES.has(f['t'] as string)) sequenced += 1;
  }
  const deadline = Date.now() + 5_000;
  const seqCount = () => observer.wire.filter((x) => typeof x.seq === 'number').length;
  while (seqCount() < sequenced && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Ephemeral frames and the cursor tick.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const leaks: { where: string; sample: string }[] = [];
  const check = (where: string, text: string): void => {
    const at = text.indexOf(canary);
    if (at >= 0)
      leaks.push({ where, sample: text.slice(Math.max(0, at - 60), at + canary.length + 20) });
  };
  check('logs', relay.logs());
  const metricsText = JSON.stringify(relay.metricSeries());
  check('metrics', metricsText);
  for (const frame of await relay.buffered()) check('hot buffer', JSON.stringify(withoutCt(frame)));
  for (const frame of relay.durable()) check('durable log', JSON.stringify(withoutCt(frame)));
  for (const client of [sender, observer]) {
    for (const f of client.wire) {
      if (f.t === 'sys.error') check('error frames', JSON.stringify(f));
      else check('delivered clear parts', JSON.stringify(withoutCt(f as Record<string, unknown>)));
    }
  }
  // The canary did travel, inside ciphertext only.
  const inCt = observer.wire.some((f) =>
    JSON.stringify((f as Record<string, unknown>)['ct'] ?? '').includes(canary),
  );
  if (!inCt)
    throw new Error('the canary never reached another member inside ct: the run sent nothing');
  return { leaks, kinds, idLabels: /ses_|mem_/.test(metricsText) };
}
