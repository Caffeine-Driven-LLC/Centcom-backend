/**
 * Queue stores (B052): in memory (tests, and relays without Postgres) and in Postgres
 * (`queue_session`, `queue_item`).
 *
 * - **Lock:** the memory store chains each session's callers; Postgres opens a transaction and
 *   takes the session's `queue_session` row `FOR UPDATE` (creating it on first use), so two nodes
 *   never change one queue at once.
 * - **Rows:** one per item ever submitted (never its body): id, submitter, state, what a held item
 *   was, position, size, kind, agent, the submit's timestamp, and the seqs that created and last
 *   changed it. `position` is the item's index in the order (null outside it). The session row
 *   holds the version, whether the host is away, and the last frame applied.
 *
 * Owns: persistence. Must not: decide transitions (the state machine does).
 */
import type { createDb, QueueDatabase } from '@centcom/db';
import type { PersistedQueue, QueueStore, QueueTx } from './ports.js';
import type { QueueItem, QueueModel, QueueState } from './state-machine.js';

/** The relay's client over the queue tables. */
export type QueueDb = ReturnType<typeof createDb<QueueDatabase>>;

/** The rows `save` writes: the changed items and every item in the order (positions move). */
function touched(model: QueueModel, changed: readonly string[]): QueueItem[] {
  const ids = new Set([...changed, ...model.order]);
  return [...ids].map((id) => model.items.get(id)).filter((i): i is QueueItem => i !== undefined);
}

const copyItem = (i: QueueItem): QueueItem => ({ ...i });

/** Queues in memory; `failing` makes every save throw. */
export function createMemoryQueueStore(): QueueStore & {
  failing: boolean;
  rows(sid: string): PersistedQueue | undefined;
} {
  const sessions = new Map<string, PersistedQueue>();
  const locks = new Map<string, Promise<unknown>>();
  const store = {
    failing: false,
    rows: (sid: string) => sessions.get(sid),
    async withSession<T>(sid: string, fn: (tx: QueueTx) => Promise<T>): Promise<T> {
      const before = locks.get(sid) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const chained = before.then(() => mine);
      locks.set(sid, chained);
      await before.catch(() => undefined);
      let staged: PersistedQueue | undefined;
      const tx: QueueTx = {
        load: () => {
          const current = staged ?? sessions.get(sid);
          return Promise.resolve(
            current === undefined
              ? null
              : { ...current, order: [...current.order], items: current.items.map(copyItem) },
          );
        },
        save(model, changed, updatedSeq) {
          if (store.failing) return Promise.reject(new Error('queue store down'));
          const base = staged ?? sessions.get(sid);
          const items = new Map((base?.items ?? []).map((i) => [i.item, copyItem(i)]));
          for (const i of touched(model, changed)) items.set(i.item, copyItem(i));
          staged = {
            version: model.version,
            hostAway: model.hostAway,
            updatedSeq,
            order: [...model.order],
            items: [...items.values()],
          };
          return Promise.resolve();
        },
      };
      try {
        const result = await fn(tx);
        if (staged !== undefined) sessions.set(sid, staged);
        return result;
      } finally {
        release();
        if (locks.get(sid) === chained) locks.delete(sid);
      }
    },
  };
  return store;
}

/** Queues in Postgres. */
export function createPostgresQueueStore(db: QueueDb): QueueStore {
  return {
    withSession(sid, fn) {
      return db.transaction().execute(async (trx) => {
        await trx
          .insertInto('queue_session')
          .values({ session_id: sid })
          .onConflict((oc) => oc.column('session_id').doNothing())
          .execute();
        const session = await trx
          .selectFrom('queue_session')
          .select(['version', 'host_away', 'updated_seq'])
          .where('session_id', '=', sid)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const tx: QueueTx = {
          async load() {
            const rows = await trx
              .selectFrom('queue_item')
              .selectAll()
              .where('session_id', '=', sid)
              .execute();
            if (rows.length === 0 && Number(session.version) === 0) return null;
            const items: QueueItem[] = rows.map((r) => ({
              item: r.item_id,
              submitter: r.submitter,
              state: r.state as QueueState,
              ...(r.held_from === null ? {} : { heldFrom: r.held_from }),
              size: r.size,
              kind: r.kind,
              ts: r.ts.toISOString(),
              ...(r.agent_id === null ? {} : { agentId: r.agent_id }),
              createdSeq: Number(r.created_seq),
              updatedSeq: Number(r.updated_seq),
            }));
            const order = rows
              .filter((r) => r.position !== null)
              .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
              .map((r) => r.item_id);
            return {
              version: Number(session.version),
              hostAway: session.host_away,
              updatedSeq: Number(session.updated_seq),
              order,
              items,
            };
          },
          async save(model, changed, updatedSeq) {
            const now = new Date();
            await trx
              .updateTable('queue_session')
              .set({
                version: model.version,
                host_away: model.hostAway,
                updated_seq: updatedSeq,
                updated_at: now,
              })
              .where('session_id', '=', sid)
              .execute();
            for (const i of touched(model, changed)) {
              const index = model.order.indexOf(i.item);
              const values = {
                ts: i.ts,
                created_seq: i.createdSeq,
                state: i.state,
                held_from: i.heldFrom ?? null,
                position: index === -1 ? null : index,
                agent_id: i.agentId ?? null,
                updated_seq: i.updatedSeq,
              };
              await trx
                .insertInto('queue_item')
                .values({
                  session_id: sid,
                  item_id: i.item,
                  submitter: i.submitter,
                  size: i.size,
                  kind: i.kind,
                  ...values,
                })
                .onConflict((oc) =>
                  oc.columns(['session_id', 'item_id']).doUpdateSet({ ...values, updated_at: now }),
                )
                .execute();
            }
          },
        };
        return fn(tx);
      });
    },
  };
}
