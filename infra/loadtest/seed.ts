/**
 * Synthetic data for a relay load test (B095): one workspace on the Team plan, a pool of synthetic
 * users with a device each, and sessions of N members seeded straight into Postgres, because the
 * relay's handshake checks the live records (session, membership, device, plan) before it admits
 * anyone. Nothing here resembles a real person: ids and `user-N@example.test` addresses only.
 */
import { createDb, closeDb, type CoreDatabase, type EntitlementsDatabase } from '@centcom/db';
import { createFactories } from '@centcom/testkit';

export interface SeededMember {
  mid: string;
  dev: string;
  role: 'host' | 'editor';
}
export interface SeededSession {
  sid: string;
  members: SeededMember[];
}

const POOL = 64;

type LoadDb = ReturnType<typeof createDb<CoreDatabase & EntitlementsDatabase>>;
type CoreKysely = Parameters<typeof createFactories>[0];

export class Seeder {
  private constructor(
    private readonly db: LoadDb,
    private readonly f: ReturnType<typeof createFactories>,
    private readonly workspace: string,
    private readonly pool: { user: string; device: string }[],
  ) {}

  static async create(databaseUrl: string): Promise<Seeder> {
    const db = createDb<CoreDatabase & EntitlementsDatabase>({
      url: databaseUrl,
      poolMax: 10,
      applicationName: 'loadtest-seed',
      statementTimeoutMs: 60_000,
    });
    const f = createFactories(db as unknown as CoreKysely);
    const workspace = await f.workspaces.create();
    await db
      .insertInto('workspace_entitlements')
      .values({ workspace_id: workspace.id, plan_id: 'team', status: 'active' })
      .execute();
    const pool: { user: string; device: string }[] = [];
    for (let i = 0; i < POOL; i += 1) {
      const user = await f.users.create({ display_name: `Load ${i}` });
      await f.memberships.create({ workspace: workspace.id, user: user.id, role: 'member' });
      const device = await f.devices.create({ user: user.id });
      pool.push({ user: user.id, device: device.id });
    }
    return new Seeder(db, f, workspace.id, pool);
  }

  /** `count` live sessions of `members` members each (the first is the host). */
  async sessions(count: number, members: number, offset = 0): Promise<SeededSession[]> {
    if (members > POOL) throw new RangeError(`at most ${POOL} members per session`);
    const out: SeededSession[] = new Array<SeededSession>(count);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < count; i = next++) {
        const session = await this.f.sessions.create({ workspace: this.workspace, state: 'live' });
        const seeded: SeededMember[] = [];
        for (let m = 0; m < members; m += 1) {
          const who = this.pool[(offset + i * members + m) % POOL];
          if (who === undefined) throw new Error('empty user pool');
          const role = m === 0 ? 'host' : 'editor';
          const row = await this.f.sessionMembers.create({
            session: session.id,
            user: who.user,
            device: who.device,
            role,
          });
          seeded.push({ mid: row.id, dev: who.device, role });
        }
        out[i] = { sid: session.id, members: seeded };
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    return out;
  }

  async close(): Promise<void> {
    await closeDb(this.db);
  }
}
