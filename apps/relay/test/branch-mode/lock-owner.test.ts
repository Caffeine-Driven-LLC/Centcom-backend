/**
 * B110 (audit): a lock names its agent in the clear `p`. With an agent registry behind the service,
 * a non-host member may only lock for an agent they own; the host may lock for any agent; a lock
 * for an unknown agent is refused to an editor; a registry that cannot answer is `service_unavailable`.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { lock, lockEnv } from '../locks/helpers.js';

describe('file.lock and agent ownership', () => {
  it("an editor locks for its own agent, not for another member's", async () => {
    const [mine, theirs] = [newId('agt'), newId('agt')];
    const env: ReturnType<typeof lockEnv> = lockEnv({
      agents: {
        ownerOf: (_s, agent) =>
          Promise.resolve(
            agent === mine
              ? env.editor.memberId
              : agent === theirs
                ? env.other.memberId
                : undefined,
          ),
      },
    });
    expect(await env.send(lock('acquire', 'p1', mine), env.editor)).toEqual({ outcome: 'granted' });
    const stolen = await env.send(lock('acquire', 'p2', theirs), env.editor);
    expect(stolen).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    const unknown = await env.send(lock('acquire', 'p3', newId('agt')), env.editor);
    expect(unknown).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    expect(await env.send(lock('acquire', 'p2', theirs), env.host)).toEqual({ outcome: 'granted' });
  });

  it('release is checked the same way', async () => {
    const mine = newId('agt');
    const env: ReturnType<typeof lockEnv> = lockEnv({
      agents: { ownerOf: () => Promise.resolve(env.editor.memberId) },
    });
    await env.send(lock('acquire', 'p1', mine), env.editor);
    const other = await env.send(lock('release', 'p1', mine), env.other);
    expect(other).toMatchObject({ outcome: 'refused', code: 'forbidden' });
    expect(await env.send(lock('release', 'p1', mine), env.editor)).toEqual({
      outcome: 'released',
    });
  });

  it('a registry that cannot answer is service_unavailable', async () => {
    const env = lockEnv({ agents: { ownerOf: () => Promise.reject(new Error('down')) } });
    expect(await env.send(lock('acquire', 'p1', newId('agt')), env.editor)).toMatchObject({
      outcome: 'refused',
      code: 'service_unavailable',
    });
  });
});
