/**
 * B061 wiring: `branches/module.ts` registers its stage at 39 and sets `ctx.conflicts`; with B059's
 * locks module beside it, a contested `file.lock` acquire through the pipeline becomes one server
 * `conflict.detected` (B044's `emitServer`, `t` event, `p` with both agent ids and the one path
 * hash, no `ct`), once per pair per 30 s.
 */
import { newId } from '@centcom/contracts';
import { createMemoryRedis } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import branchesModule from '../../src/branches/module.js';
import locksModule from '../../src/locks/module.js';
import type { RelayContext } from '../../src/modules.js';
import { FramePipeline } from '../../src/pipeline.js';
import type { MemberView } from '../../src/rooms/registry.js';
import { roomsFor } from '../../src/rooms/runtime.js';
import { SEQUENCED_STATE_KEY } from '../../src/seq/types.js';
import { captureLogger, recordingMetrics } from '../helpers.js';
import { fakeConnection } from '../rooms/helpers.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('branches/module.ts', () => {
  it('turns a contested lock into one server conflict.detected', async () => {
    const pipeline = new FramePipeline();
    const shutdown: (() => Promise<void>)[] = [];
    const servers: { kind: string; t: string; p: Record<string, unknown> }[] = [];
    const sid = newId('ses');
    const agents: { agentId: string; owner: string; mode: string; state: string; since: string }[] =
      [];
    let seq = 0;
    const ctx = {
      log: captureLogger().logger,
      metrics: recordingMetrics().metrics,
      clock: Date.now,
      db: {},
      redis: createMemoryRedis(),
      pipeline,
      agents: { snapshot: () => Promise.resolve(agents) },
      fanout: {
        emitServer(_sid: string, kind: string, t: string, p: Record<string, unknown>) {
          servers.push({ kind, t, p });
          return Promise.resolve({ seq: ++seq });
        },
        emitServerBatch(
          _sid: string,
          frames: { kind: string; t: string; p: Record<string, unknown> }[],
        ) {
          servers.push(...frames);
          return Promise.resolve([]);
        },
      },
      onConnection: () => undefined,
      onShutdown: (fn: () => Promise<void>) => void shutdown.push(fn),
    } as unknown as RelayContext;
    await branchesModule.register(ctx);
    await locksModule.register(ctx);
    expect(ctx.conflicts).toBeDefined();
    // Sequencing stands in at 40.
    pipeline.use(40, (fc, next) => {
      fc.state[SEQUENCED_STATE_KEY] = { ...(fc.frame as object), seq: ++seq };
      return next();
    });
    expect(pipeline.orders()).toEqual([39, 39, 40]);

    const member = (role: 'host' | 'editor'): MemberView => ({
      id: newId('mem'),
      sid,
      role,
      userId: newId('usr'),
      workspaceId: newId('wsp'),
      name: 'Alex',
      slot: 0,
    });
    const room = roomsFor(ctx).registry.getOrCreate(sid);
    const [host, editor] = [member('host'), member('editor')];
    const [hostConn, editorConn] = [fakeConnection(sid), fakeConnection(sid)];
    room.join(hostConn, host);
    room.join(editorConn, editor);
    const [a, b] = [newId('agt'), newId('agt')];
    agents.push(
      { agentId: a, owner: host.id, mode: 'command_post', state: '', since: '' },
      { agentId: b, owner: editor.id, mode: 'command_post', state: '', since: '' },
    );
    const acquire = (conn: typeof hostConn, agent: string) =>
      pipeline.run({
        connection: conn,
        raw: null,
        frame: {
          v: 1,
          t: 'event',
          id: newId('msg'),
          k: 'file.lock',
          p: { action: 'acquire', path_hmac: 'PathA', agent_id: agent },
          ct: { alg: 'xchacha20poly1305', kid: 'k1', n: 'A'.repeat(32), c: 'AAAA' },
        },
        state: {},
      });
    await acquire(hostConn, a);
    await acquire(editorConn, b);
    await acquire(editorConn, b);
    await settle();
    const signals = servers.filter((s) => s.kind === 'conflict.detected');
    expect(signals).toEqual([
      { kind: 'conflict.detected', t: 'event', p: { agent_ids: [a, b], path_hmacs: ['PathA'] } },
    ]);
    for (const fn of shutdown) await fn();
  });
});
