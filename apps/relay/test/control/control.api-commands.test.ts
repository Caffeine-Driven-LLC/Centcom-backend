/**
 * Commands from the API on the relay's control channel (B106): only well-formed host changes and
 * session states become frames; anything else is dropped.
 */
import { describe, expect, it } from 'vitest';
import { parseControlCommand } from '../../src/control/module.js';

const SID = 'ses_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const MEM = 'mem_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

describe('parseControlCommand', () => {
  it('accepts a host change and a session state', () => {
    expect(
      parseControlCommand(
        JSON.stringify({ kind: 'host_changed', sid: SID, host: MEM, code: 'failover' }),
      ),
    ).toEqual({ kind: 'host_changed', sid: SID, host: MEM, code: 'failover' });
    expect(
      parseControlCommand(JSON.stringify({ kind: 'session_state', sid: SID, state: 'ended' })),
    ).toEqual({ kind: 'session_state', sid: SID, state: 'ended' });
  });
  it('drops anything malformed', () => {
    for (const bad of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ kind: 'host_changed', sid: 'x', host: MEM, code: 'failover' }),
      JSON.stringify({ kind: 'host_changed', sid: SID, host: 'usr_x', code: 'failover' }),
      JSON.stringify({ kind: 'host_changed', sid: SID, host: MEM, code: 'kick' }),
      JSON.stringify({ kind: 'session_state', sid: SID, state: 'pending' }),
      JSON.stringify({ kind: 'rotate', sid: SID }),
    ]) {
      expect(parseControlCommand(bad), bad).toBeNull();
    }
  });
});
