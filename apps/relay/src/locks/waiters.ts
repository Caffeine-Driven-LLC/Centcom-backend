/**
 * Wait queues of contested paths (B059): first come, first served, at most MAX_WAITERS per path.
 * Pure functions over a session's queues (`SessionLocks.queues`), so the service applies them
 * under the session's lock.
 *
 * - `enqueue`: adds a waiter at the back; a waiter already queued for the path (same agent) keeps
 *   its place (a resend or a repeated acquire does not queue twice); a full queue refuses.
 * - `next`: takes the front waiter of a path, skipping none.
 * - `dropWaiters`: removes an agent's or a member's waiters everywhere (exit, leave, kick).
 *
 * Owns: queue order. Must not: grant anything (the service does).
 */
import { MAX_WAITERS, type Waiter } from './ports.js';

/** Adds `waiter` for `path`: its 1-based position, or null when the queue is full. */
export function enqueue(
  queues: Map<string, Waiter[]>,
  path: string,
  waiter: Waiter,
): number | null {
  const queue = queues.get(path) ?? [];
  const already = queue.findIndex((w) => w.agent === waiter.agent);
  if (already >= 0) return already + 1;
  if (queue.length >= MAX_WAITERS) return null;
  queue.push(waiter);
  queues.set(path, queue);
  return queue.length;
}

/** The front waiter of `path`, removed; undefined when none waits. */
export function next(queues: Map<string, Waiter[]>, path: string): Waiter | undefined {
  const queue = queues.get(path);
  const first = queue?.shift();
  if (queue !== undefined && queue.length === 0) queues.delete(path);
  return first;
}

/** Removes the waiters `match` selects, on every path; resolves to how many went. */
export function dropWaiters(queues: Map<string, Waiter[]>, match: (w: Waiter) => boolean): number {
  let dropped = 0;
  for (const [path, queue] of queues) {
    const kept = queue.filter((w) => !match(w));
    dropped += queue.length - kept.length;
    if (kept.length === 0) queues.delete(path);
    else queues.set(path, kept);
  }
  return dropped;
}
