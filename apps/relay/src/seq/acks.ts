/**
 * Acknowledgements (B041, CT-WS-ENVELOPE "Sequencing and delivery guarantees"): each connection's
 * highest acknowledged `seq` (`acked_seq`), which only rises, and per session the lowest of them on
 * this node (what B046's backpressure and B042's replay read). The sequence stage checks an ack
 * against the session's head before it gets here.
 *
 * Owns: `acked_seq` per connection. Must not: keep a connection after `forget`.
 */
import type { AckTracker } from './types.js';

/** The tracker, with the calls the sequence stage makes. */
export interface ConnectionAckTracker extends AckTracker {
  /** Starts tracking connection `connId` of session `sid` (acked_seq 0). */
  track(connId: string, sid: string): void;
  /** Stops tracking `connId` (it closed). */
  forget(connId: string): void;
  /** `acked_seq` of `connId`; 0 when unknown. */
  acked(connId: string): number;
  /** Connections tracked. */
  readonly size: number;
}

/** An empty tracker. */
export function createAckTracker(): ConnectionAckTracker {
  const sessionOf = new Map<string, string>();
  const bySession = new Map<string, Map<string, number>>();
  return {
    track(connId, sid) {
      if (sessionOf.has(connId)) return;
      sessionOf.set(connId, sid);
      let conns = bySession.get(sid);
      if (conns === undefined) {
        conns = new Map();
        bySession.set(sid, conns);
      }
      conns.set(connId, 0);
    },
    forget(connId) {
      const sid = sessionOf.get(connId);
      if (sid === undefined) return;
      sessionOf.delete(connId);
      const conns = bySession.get(sid);
      conns?.delete(connId);
      if (conns?.size === 0) bySession.delete(sid);
    },
    onAck(connId, seq) {
      const sid = sessionOf.get(connId);
      if (sid === undefined || !Number.isSafeInteger(seq) || seq < 0) return;
      const conns = bySession.get(sid);
      const current = conns?.get(connId) ?? 0;
      if (seq > current) conns?.set(connId, seq);
    },
    lowestAcked(sid) {
      const conns = bySession.get(sid);
      if (conns === undefined || conns.size === 0) return 0;
      return Math.min(...conns.values());
    },
    acked: (connId) => {
      const sid = sessionOf.get(connId);
      return sid === undefined ? 0 : (bySession.get(sid)?.get(connId) ?? 0);
    },
    get size() {
      return sessionOf.size;
    },
  };
}
