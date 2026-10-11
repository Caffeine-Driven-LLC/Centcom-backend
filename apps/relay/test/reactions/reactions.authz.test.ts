/**
 * B062 who may react and comment (acceptance 4; CT-RBAC "Presence, cursors, reactions, comments"):
 * host, editor and viewer may send `reaction` and `comment.add`; a muted member's are refused
 * before this stage by B043's authorisation, with `muted` (CT-ERR's code for it, as B052's queue
 * frames); a refused frame never reaches the stores.
 */
import { newId } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { authorizeFrame, noMutes, type MuteState } from '../../src/rooms/kind-policy.js';

const sid = newId('ses');
const muted = newId('mem');
const mutes: MuteState = { isMuted: (_sid, mid) => mid === muted };

describe('who may react and comment (acceptance 4)', () => {
  it.each(['host', 'editor', 'viewer'] as const)('%s may send both kinds', (role) => {
    for (const k of ['reaction', 'comment.add']) {
      expect(authorizeFrame({ id: newId('mem'), sid, role }, { t: 'event', k }, noMutes)).toEqual({
        ok: true,
      });
    }
  });

  it('a muted member is refused (muted), whatever the role', () => {
    for (const role of ['editor', 'viewer'] as const) {
      for (const k of ['reaction', 'comment.add']) {
        expect(authorizeFrame({ id: muted, sid, role }, { t: 'event', k }, mutes)).toEqual({
          ok: false,
          error: 'muted',
        });
      }
    }
  });
});
