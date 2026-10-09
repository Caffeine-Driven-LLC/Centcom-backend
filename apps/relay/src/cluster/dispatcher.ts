/**
 * The cluster dispatcher (B045): B044's `RemoteDispatcher` over Redis pub/sub, and the receiving
 * side of a session's channels.
 *
 * - **Publish:** each locally sequenced frame goes to `relay:{sid}:frames` as `{node, sid, at, frame}`
 *   (the frame as stored; ciphertext opaque). A failed publish is counted
 *   (`relay_cluster_publish_failed_total`) and rejected (fan-out counts it too); the frame is in
 *   the hot buffer already, so other nodes recover it by gap-fill.
 * - **Receive:** a message from this node is ignored (its frames were delivered locally); a
 *   malformed one is counted and dropped; any other goes to B044's `OrderedRelease`, which
 *   reorders it, drops what it already released (`seq` dedupe) and asks for a missing range after
 *   `RELAY_CLUSTER_GAP_MS` (fan-out fills it from `SeqStore.range`, or closes the room 1001 when
 *   the buffer cannot). Pub/sub is lossy and unordered across publishers: nothing here assumes
 *   delivery or order, and no `seq` is ever made up locally.
 * - **Ephemeral** (`relay:{sid}:eph`): presence frames go straight to the local connections, never
 *   into the release, the buffer or the durable log.
 * - **Reconcile:** a session's release is compared with the store's head; frames past what was
 *   released are fetched from the buffer and offered (a lost last frame, or messages lost while
 *   pub/sub reconnected, are delivered even when nothing follows them).
 *
 * Never logs a message or a frame.
 *
 * Owns: the frame and ephemeral channels' publish and receive. Must not: feed ephemeral frames to
 * the release, or deliver a frame out of `seq` order.
 */
import { noopMetrics, type Logger, type Metrics, type PubSub } from '@centcom/core';
import type { RemoteDispatcher } from '../fanout/fanout.js';
import type { OrderedRelease } from '../fanout/release.js';
import { MAX_RANGE } from '../seq/retention.js';
import type { SeqStore, StoredFrame } from '../seq/types.js';
import {
  ephemeralChannel,
  framesChannel,
  parseEphemeralMessage,
  parseFrameMessage,
} from './channels.js';

/** `relay_cluster_lag_seconds` buckets. */
export const LAG_BUCKETS_S: readonly number[] = Object.freeze([
  0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1,
]);

/** What the dispatcher needs. */
export interface ClusterDispatcherDeps {
  redis: Pick<PubSub, 'publish'>;
  nodeId: string;
  release: Pick<OrderedRelease, 'offer' | 'expected'>;
  seq: Pick<SeqStore, 'head' | 'range'>;
  /** Milliseconds since the epoch; default Date.now. */
  clock?: () => number;
  metrics?: Metrics;
  logger?: Logger;
}

/** Publishes local frames to the other nodes and takes theirs in. */
export class ClusterDispatcher implements RemoteDispatcher {
  readonly #deps: ClusterDispatcherDeps;
  readonly #metrics: Metrics;
  readonly #clock: () => number;

  constructor(deps: ClusterDispatcherDeps) {
    this.#deps = deps;
    this.#metrics = deps.metrics ?? noopMetrics;
    this.#clock = deps.clock ?? Date.now;
  }

  get nodeId(): string {
    return this.#deps.nodeId;
  }

  /** Publishes a locally sequenced frame of `sid` to the other nodes. */
  async publish(sid: string, frame: StoredFrame): Promise<void> {
    const message = JSON.stringify({ node: this.#deps.nodeId, sid, at: this.#clock(), frame });
    try {
      await this.#deps.redis.publish(framesChannel(sid), message);
      this.#metrics.counter('relay_cluster_published_total', { channel: 'frames' }).inc();
    } catch (err) {
      this.#metrics.counter('relay_cluster_publish_failed_total', { channel: 'frames' }).inc();
      throw err;
    }
  }

  /** Publishes an ephemeral (presence) frame of `sid`; failures are counted, never thrown. */
  async publishEphemeral(sid: string, frame: Record<string, unknown>): Promise<void> {
    const message = JSON.stringify({ node: this.#deps.nodeId, sid, frame });
    try {
      await this.#deps.redis.publish(ephemeralChannel(sid), message);
      this.#metrics.counter('relay_cluster_published_total', { channel: 'eph' }).inc();
    } catch {
      this.#metrics.counter('relay_cluster_publish_failed_total', { channel: 'eph' }).inc();
    }
  }

  /** A message of `relay:{sid}:frames`: another node's frame into the ordered release. */
  receive(sid: string, message: string): void {
    const parsed = parseFrameMessage(message, sid);
    if (parsed === null) {
      this.#received('frames', 'invalid');
      return;
    }
    if (parsed.node === this.#deps.nodeId) {
      this.#received('frames', 'own');
      return;
    }
    // The hop: publish on the origin node to arrival here (not the origin's own queueing).
    const sent = parsed.at ?? Date.parse(parsed.frame.ts);
    if (!Number.isNaN(sent)) {
      this.#metrics
        .histogram('relay_cluster_lag_seconds', LAG_BUCKETS_S)
        .observe(Math.max(0, this.#clock() - sent) / 1000);
    }
    this.#received('frames', 'offered');
    this.#deps.release.offer(sid, parsed.frame);
  }

  /**
   * A message of `relay:{sid}:eph`: another node's ephemeral frame, handed to `deliver` (the local
   * connections) as its exact text; never to the release.
   */
  receiveEphemeral(sid: string, message: string, deliver: (frameText: string) => void): void {
    const parsed = parseEphemeralMessage(message, sid);
    if (parsed === null) {
      this.#received('eph', 'invalid');
      return;
    }
    if (parsed.node === this.#deps.nodeId) {
      this.#received('eph', 'own');
      return;
    }
    this.#received('eph', 'delivered');
    deliver(JSON.stringify(parsed.frame));
  }

  /**
   * Offers the frames of `sid` the store has past what the release delivered; resolves with how
   * many. Frames the buffer no longer has leave a gap, which fan-out turns into a resync.
   */
  async reconcile(sid: string): Promise<number> {
    const expected = this.#deps.release.expected(sid);
    if (expected === null) return 0;
    const head = await this.#deps.seq.head(sid);
    if (head < expected) return 0;
    let frames = await this.#deps.seq.range(
      sid,
      expected - 1,
      Math.min(MAX_RANGE, head - expected + 1),
    );
    // Trimmed past `expected`: offering the newest frame opens the gap fan-out resolves.
    if (frames.length === 0) frames = await this.#deps.seq.range(sid, head - 1, 1);
    for (const frame of frames) this.#deps.release.offer(sid, frame);
    if (frames.length > 0)
      this.#metrics.counter('relay_cluster_reconciled_total').inc(frames.length);
    return frames.length;
  }

  #received(channel: 'frames' | 'eph', result: string): void {
    this.#metrics.counter('relay_cluster_received_total', { channel, result }).inc();
  }
}
