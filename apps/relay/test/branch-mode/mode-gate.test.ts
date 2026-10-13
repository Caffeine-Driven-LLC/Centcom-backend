/**
 * B110: the command-post gate and the mode store.
 *
 * - In a `command_post` session an editor's `message.*`, `tool.*`, `approval.request`, `diff.share`,
 *   `file.lock` and `agent.handoff` are refused `forbidden` and not sequenced; the host's pass; in a
 *   `branch` session an editor's pass; a handoff offer must come from the agent's owner.
 * - A failing mode lookup answers `service_unavailable` (fail closed) and sequences nothing.
 * - The Postgres mode port reads `sessions.mode`, remembers a found mode, treats an unknown session
 *   as a command post without remembering it, and rejects when the read fails.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import type { SessionModePort } from '../../src/agents/ports.js';
import { createPostgresSessionModes } from '../../src/agents/mode-store.js';
import { commandPostGate, HOST_ONLY_IN_COMMAND_POST } from '../../src/agents/mode-gate.js';
import type { FrameContext, RelayConnection } from '../../src/pipeline.js';

const SID = newId('ses');
const HOST = newId('mem');
const EDITOR = newId('mem');
const OTHER = newId('mem');
const AGENT = newId('agt');

const modes = (mode: 'command_post' | 'branch' | 'fail'): SessionModePort => ({
  modeOf: () => (mode === 'fail' ? Promise.reject(new Error('db down')) : Promise.resolve(mode)),
});

function run(
  mode: 'command_post' | 'branch' | 'fail',
  role: 'host' | 'editor',
  frame: Record<string, unknown>,
  owners?: Record<string, string>,
) {
  const sent: Record<string, unknown>[] = [];
  const conn = { send: (f: object) => (sent.push(f as Record<string, unknown>), true) };
  const stage = commandPostGate({
    modes: modes(mode),
    rooms: {
      locate: () =>
        ({
          room: { sid: SID },
          member: { id: role === 'host' ? HOST : EDITOR, role, sid: SID },
        }) as never,
    },
    ...(owners === undefined
      ? {}
      : { owners: { ownerOf: (_sid: string, agent: string) => Promise.resolve(owners[agent]) } }),
  });
  const fc: FrameContext = {
    connection: conn as unknown as RelayConnection,
    raw: null,
    frame,
    state: {},
  };
  let nexts = 0;
  return stage(fc, () => {
    nexts += 1;
    return Promise.resolve();
  }).then(() => ({ sent, nexts }));
}

const event = (k: string, p?: unknown) => ({
  v: 1,
  t: 'event',
  id: newId('msg'),
  k,
  ...(p ? { p } : {}),
});

describe('the command-post gate', () => {
  it.each([...HOST_ONLY_IN_COMMAND_POST])("refuses an editor's %s in a command post", async (k) => {
    const out = await run('command_post', 'editor', event(k));
    expect(out.nexts).toBe(0);
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0]).toMatchObject({ t: 'sys.error', p: { code: 'forbidden' } });
  });

  it.each([...HOST_ONLY_IN_COMMAND_POST])('lets the host send %s in a command post', async (k) => {
    expect(await run('command_post', 'host', event(k))).toMatchObject({ nexts: 1, sent: [] });
  });

  it('lets an editor send them in a branch session', async () => {
    for (const k of ['message.user', 'tool.result', 'file.lock', 'diff.share']) {
      expect(await run('branch', 'editor', event(k))).toMatchObject({ nexts: 1, sent: [] });
    }
  });

  it('leaves other kinds alone in either mode', async () => {
    for (const k of ['queue.submit', 'comment.add', 'reaction', 'key.grant', 'board.note']) {
      expect(await run('command_post', 'editor', event(k))).toMatchObject({ nexts: 1, sent: [] });
    }
  });

  it("a handoff offer in a branch session must come from the agent's owner", async () => {
    const offer = event('agent.handoff', {
      handoff: newId('msg'),
      agent_id: AGENT,
      to: OTHER,
      op: 'offer',
    });
    expect(await run('branch', 'editor', offer, { [AGENT]: EDITOR })).toMatchObject({ nexts: 1 });
    const stolen = await run('branch', 'editor', offer, { [AGENT]: OTHER });
    expect(stolen.nexts).toBe(0);
    expect(stolen.sent[0]).toMatchObject({ p: { code: 'forbidden' } });
    expect(await run('branch', 'host', offer, { [AGENT]: OTHER })).toMatchObject({ nexts: 1 });
  });

  it('answers service_unavailable when the mode cannot be read, sequencing nothing', async () => {
    const out = await run('fail', 'editor', event('message.user'));
    expect(out.nexts).toBe(0);
    expect(out.sent[0]).toMatchObject({ p: { code: 'service_unavailable' } });
  });
});

describe('the Postgres mode port', () => {
  function fakeDb(rows: Map<string, 'command_post' | 'branch'>, reads: string[], fail = false) {
    return {
      selectFrom: () => ({
        select: () => ({
          where: (_c: string, _o: string, sid: string) => ({
            executeTakeFirst: () => {
              reads.push(sid);
              if (fail) return Promise.reject(new Error('db down'));
              const mode = rows.get(sid);
              return Promise.resolve(mode === undefined ? undefined : { mode });
            },
          }),
        }),
      }),
    };
  }

  it('reads the mode once and remembers it', async () => {
    const reads: string[] = [];
    const port = createPostgresSessionModes(fakeDb(new Map([[SID, 'branch']]), reads));
    expect(await port.modeOf(SID)).toBe('branch');
    expect(await port.modeOf(SID)).toBe('branch');
    expect(reads).toEqual([SID]);
  });

  it('an unknown session is a command post and is not remembered', async () => {
    const reads: string[] = [];
    const rows = new Map<string, 'command_post' | 'branch'>();
    const port = createPostgresSessionModes(fakeDb(rows, reads));
    expect(await port.modeOf(SID)).toBe('command_post');
    rows.set(SID, 'branch');
    expect(await port.modeOf(SID)).toBe('branch');
    expect(reads).toHaveLength(2);
  });

  it('rejects when the read fails, and forgets on request', async () => {
    const port = createPostgresSessionModes(fakeDb(new Map(), [], true));
    await expect(port.modeOf(SID)).rejects.toThrow('db down');
    const second = newId('ses');
    const rows = new Map<string, 'command_post' | 'branch'>([
      [SID, 'branch'],
      [second, 'command_post'],
    ]);
    const reads: string[] = [];
    const ok = createPostgresSessionModes(fakeDb(rows, reads), { max: 1 });
    await ok.modeOf(SID);
    await ok.modeOf(second); // evicts the oldest
    await ok.modeOf(SID);
    expect(reads.filter((s) => s === SID)).toHaveLength(2);
  });
});
