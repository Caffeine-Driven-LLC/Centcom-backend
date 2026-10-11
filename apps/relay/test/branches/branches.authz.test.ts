/**
 * B061 who may signal (acceptance 6; CT-WS-SESSION-EVENTS `editor*`): a viewer never sends
 * `branch.update` or `conflict.detected` (`forbidden`); in a `command_post` session only the host
 * may; in a `branch` session an editor may too.
 */
import { describe, expect, it } from 'vitest';
import { branchUpdate, conflict, signalEnv } from './helpers.js';

describe('who may signal (acceptance 6)', () => {
  it('command_post: the host only', async () => {
    const env = signalEnv({ mode: 'command_post' });
    const a = env.agentOf(env.host);
    for (const by of [env.viewer, env.editor]) {
      expect((await env.send(branchUpdate(), by)).error).toMatchObject({
        p: { code: 'forbidden' },
      });
      expect((await env.send(conflict([a], ['h']), by)).error).toMatchObject({
        p: { code: 'forbidden' },
      });
    }
    expect((await env.send(branchUpdate(), env.host)).passed).toBe(true);
    expect((await env.send(conflict([a], ['h']), env.host)).passed).toBe(true);
    expect(env.sequenced).toHaveLength(2);
  });

  it('branch: editors too, viewers never', async () => {
    const env = signalEnv({ mode: 'branch' });
    const a = env.agentOf(env.editor);
    expect((await env.send(branchUpdate(), env.editor)).passed).toBe(true);
    expect((await env.send(conflict([a], ['h']), env.editor)).passed).toBe(true);
    expect((await env.send(branchUpdate(), env.viewer)).error).toMatchObject({
      p: { code: 'forbidden' },
    });
  });
});
