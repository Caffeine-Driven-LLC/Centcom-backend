/**
 * `branch.update` (B061, CT-WS-SESSION-EVENTS): an encrypted-only frame (the agent, branch, head,
 * ahead, behind and dirty state are all in `ct`). The relay checks who sent it and its shape, and
 * sequences it unchanged: `ct` is never opened, parsed, stored or logged.
 *
 * - **Who:** host and editor pass B043 (viewers never get here; refused again here); in a
 *   `command_post` session only the host may send it (the catalogue's `editor*`: "in command-post
 *   mode only the host emits"); in a `branch` session the owner emits for their own agents, which
 *   the relay cannot check (the agent is in `ct`), so any editor may.
 * - **Shape:** a `p` (cleartext) or a missing `ct` is `invalid_frame` (B039's codec refuses both
 *   already, and a `ct` over 192 KiB).
 * - **Pass-through:** every frame is sequenced and delivered in order; the relay never coalesces,
 *   drops or reorders them (senders coalesce at the source). B041's per-member rate limit applies.
 *
 * Owns: the checks. Must not: read `ct`, or block any other frame.
 */
import { noopMetrics, type Metrics } from '@centcom/core';
import type { ModePort, SignalContext, SignalFrame, SignalResult, SignalSender } from './ports.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Who may send an `editor*` kind in `sid` (CT-WS-SESSION-EVENTS catalogue note). */
export async function maySignal(
  modes: ModePort,
  sid: string,
  sender: SignalSender,
): Promise<boolean> {
  if (sender.role === 'host') return true;
  if (sender.role !== 'editor') return false;
  return (await modes.modeOf(sid)) === 'branch';
}

/** Handles `branch.update`. */
export class BranchHandler {
  readonly #metrics: Metrics;

  constructor(private readonly deps: { modes: ModePort; metrics?: Metrics }) {
    this.#metrics = deps.metrics ?? noopMetrics;
  }

  async onBranchUpdate(ctx: SignalContext, frame: SignalFrame): Promise<SignalResult> {
    if (!(await maySignal(this.deps.modes, ctx.sid, ctx.sender))) {
      return {
        outcome: 'refused',
        code: 'forbidden',
        detail: 'Only the host sends branch updates in this session.',
      };
    }
    if (frame.p !== undefined || !isRecord(frame.ct)) {
      return {
        outcome: 'refused',
        code: 'invalid_frame',
        detail: 'branch.update carries ct only.',
      };
    }
    const stored = await ctx.sequence();
    if (stored === undefined || stored === 'unknown') return { outcome: 'ignored' };
    this.#metrics.counter('relay_branch_updates_total').inc();
    return { outcome: 'sequenced' };
  }
}
