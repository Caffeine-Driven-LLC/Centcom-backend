/**
 * Fixture conformance (B011 acceptance 8, CT-WS-SESSION-EVENTS): every frame in
 * contracts/fixtures/events can be sent by a SimClient and comes back unmodified except for the
 * server-set fields; and every frame the simulator writes validates against the envelope.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateEnvelope } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkFrame,
  FrameError,
  SERVER_FIELDS,
  withoutServerFields,
  type Frame,
} from '../../src/sim/index.js';
import { connect, CONTRACTS, member, newId, reaction, startRelay, useCleanup } from './helpers.js';

useCleanup();

const EVENTS = join(CONTRACTS, 'fixtures', 'events');
const fixtures = readdirSync(EVENTS)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(join(EVENTS, file), 'utf8')) as { kind: string; frame: Frame }),
  }));

describe('the events fixtures', () => {
  it('are all there', () => {
    expect(fixtures.length).toBeGreaterThan(40);
  });

  it('can each be sent by a SimClient and echo back unmodified except from, ts and seq', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const sender = member(sid, 'host');
    const client = await connect(relay, sender, { lastSeq: 0 });
    const reader = await connect(relay, member(sid), { lastSeq: 0 });

    for (const fixture of fixtures) {
      const out = { ...withoutServerFields(fixture.frame), id: newId('msg'), sid };
      await client.sendFrame(out);
      // Presence is not echoed to its sender; the other member sees every kind.
      const seen = await reader.waitFor((frame) => frame.id === out.id);
      expect(withoutServerFields(seen), fixture.file).toEqual(out);
      expect(seen.from, fixture.file).toBe(sender.mid);
      expect(seen.k, fixture.file).toBe(fixture.kind);
      if (out.t !== 'presence') {
        const echo = await client.waitFor((frame) => frame.id === out.id);
        expect(echo, fixture.file).toEqual(seen);
        expect(echo.seq, fixture.file).toEqual(expect.any(Number));
      }
    }
  });
});

describe('frames the simulator writes', () => {
  it('all validate against the envelope', async () => {
    const relay = await startRelay();
    const sid = newId('ses');
    const client = await connect(relay, member(sid, 'host'), { lastSeq: 0 });
    const other = await connect(relay, member(sid), { lastSeq: 0 });
    await client.send('reaction', reaction());
    await client.send('comment.add');
    await client.send('presence.update', { status: 'online', activity: 'idle', agent_count: 0 });
    await other.waitFor((frame) => frame.k === 'presence.update');
    client.ack();

    const kinds = new Set(client.sent.map((frame) => frame.t));
    expect(kinds).toEqual(new Set(['sys.hello', 'event', 'presence', 'ack']));
    for (const frame of client.sent)
      expect(validateEnvelope(frame).ok, JSON.stringify(frame)).toBe(true);
    for (const frame of client.sent)
      for (const field of SERVER_FIELDS) expect(frame).not.toHaveProperty(field);
  });

  it('in debug mode, refuses to send a frame that does not validate', async () => {
    const relay = await startRelay();
    const client = await connect(relay, member(newId('ses')));
    await expect(
      client.send('reaction', { target: 'not-an-id', code: 'thumbs', op: 'add' }),
    ).rejects.toThrow(FrameError);
    expect(() => checkFrame({ v: 2, t: 'event' })).toThrow(FrameError);
    expect(client.sent.filter((frame) => frame.t === 'event')).toHaveLength(0);
  });
});
