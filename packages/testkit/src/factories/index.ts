/**
 * Factories (B010): rows of the core schema (B008) that satisfy every constraint, inserted and
 * returned, with the related rows they need created on the way. Ids come from an injected
 * generator, times from an injected clock and keys from an injected random source, so a seeded
 * setup gives the same rows on every run.
 *
 * Owns: valid default rows. Must not: produce real secrets (keys are random per run, or seeded
 * test data), or bypass a constraint of the schema.
 */
import { randomBytes } from 'node:crypto';
import { createIdGenerator, type IdPrefix } from '@centcom/contracts';
import type {
  CoreDatabase,
  DevicesTable,
  MembershipsTable,
  SessionMembersTable,
  SessionsTable,
  UsersTable,
  WorkspacesTable,
} from '@centcom/db';
import type { Insertable, Kysely, Selectable } from 'kysely';
import type { FakeClock } from '../clock.js';
import type { SeededRandom } from '../random.js';

/** What factories draw ids, times and random values from. */
export interface FactoryDeps {
  /** Ids; default a fresh `createIdGenerator()` (monotonic, CSPRNG). Use `seededIdGenerator` for repeatable ids. */
  ids?: (prefix: IdPrefix) => string;
  /** Sets every timestamp from this clock instead of the database's now(). */
  clock?: FakeClock;
  /** Keys and fingerprints; default the CSPRNG. */
  random?: SeededRandom;
}

type Db = Kysely<CoreDatabase>;
type Row<T> = Selectable<T>;

/** The resolved dependencies shared by one set of factories. */
interface Context {
  db: Db;
  ids: (prefix: IdPrefix) => string;
  bytes: (n: number) => Uint8Array;
  /** `{created_at, ...}` set from the clock, or nothing (database default). */
  at: () => { created_at?: Date };
  /** Sequence numbers per factory, for readable names. */
  next: (kind: string) => number;
}

function context(db: Db, deps: FactoryDeps): Context {
  const ids = deps.ids ?? createIdGenerator();
  const counters = new Map<string, number>();
  return {
    db,
    ids,
    bytes: (n) =>
      deps.random === undefined ? new Uint8Array(randomBytes(n)) : deps.random.bytes(n),
    at: () => (deps.clock === undefined ? {} : { created_at: deps.clock.date() }),
    next: (kind) => {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      return n;
    },
  };
}

/** RFC 4648 base32, the fingerprint alphabet of CT-CRYPTO. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A device fingerprint in the shown form `ABCD-EFGH-IJKL` (random: tests that need the real derivation compute it). */
function fingerprint(bytes: Uint8Array): string {
  const chars = [...bytes].slice(0, 12).map((b) => BASE32.charAt(b % 32));
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((part) => part.join(''))
    .join('-');
}

const publicKey = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** A reference to a row or its id. */
export type Ref = string | { id: string };
const idOf = (ref: Ref): string => (typeof ref === 'string' ? ref : ref.id);

/** Users. */
export interface UserFactory {
  create(overrides?: Partial<Insertable<UsersTable>>): Promise<Row<UsersTable>>;
}

/** Workspaces, with an owner membership. */
export interface WorkspaceFactory {
  /** Creates a workspace owned by `owner` (a new user when absent) and that owner's membership. */
  create(
    opts?: { owner?: Ref } & Partial<Insertable<WorkspacesTable>>,
  ): Promise<Row<WorkspacesTable>>;
}

/** Memberships. */
export interface MembershipFactory {
  create(
    opts: { workspace: Ref; user?: Ref } & Partial<Insertable<MembershipsTable>>,
  ): Promise<Row<MembershipsTable>>;
}

/** Devices, with random (or seeded) 32-byte public keys. */
export interface DeviceFactory {
  create(opts?: { user?: Ref } & Partial<Insertable<DevicesTable>>): Promise<Row<DevicesTable>>;
}

/** Sessions, in a workspace. */
export interface SessionFactory {
  /** Creates a session in `workspace` (a new workspace when absent), created by `createdBy` (its owner by default). */
  create(
    opts?: { workspace?: Ref; createdBy?: Ref } & Partial<Insertable<SessionsTable>>,
  ): Promise<Row<SessionsTable>>;
}

/** Session members, in the next free slot. */
export interface SessionMemberFactory {
  create(
    opts: { session: Ref; user?: Ref; device?: Ref } & Partial<Insertable<SessionMembersTable>>,
  ): Promise<Row<SessionMembersTable>>;
}

function users(ctx: Context): UserFactory {
  return {
    async create(overrides = {}) {
      const n = ctx.next('user');
      const id = overrides.id ?? ctx.ids('usr');
      const created = ctx.at().created_at;
      return ctx.db
        .insertInto('users')
        .values({
          id,
          // Derived from the id: unique, and repeatable with seeded ids.
          email: `${id.toLowerCase()}@example.test`,
          display_name: `User ${n}`,
          ...(created === undefined ? {} : { created_at: created, updated_at: created }),
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
  };
}

function memberships(ctx: Context): MembershipFactory {
  return {
    async create({ workspace, user, ...overrides }) {
      const userId = user === undefined ? (await users(ctx).create()).id : idOf(user);
      return ctx.db
        .insertInto('memberships')
        .values({
          id: ctx.ids('mem'),
          workspace_id: idOf(workspace),
          user_id: userId,
          role: 'member',
          ...ctx.at(),
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
  };
}

function workspaces(ctx: Context): WorkspaceFactory {
  return {
    async create({ owner, ...overrides } = {}) {
      const n = ctx.next('workspace');
      const ownerId = owner === undefined ? (await users(ctx).create()).id : idOf(owner);
      const id = overrides.id ?? ctx.ids('wsp');
      const created = ctx.at().created_at;
      const workspace = await ctx.db
        .insertInto('workspaces')
        .values({
          id,
          name: `Workspace ${n}`,
          // The id's random tail: unique, and a valid slug.
          slug: `ws-${id.slice(-12).toLowerCase()}`,
          created_by: ownerId,
          ...(created === undefined ? {} : { created_at: created, updated_at: created }),
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await memberships(ctx).create({ workspace, user: ownerId, role: 'owner' });
      return workspace;
    },
  };
}

function devices(ctx: Context): DeviceFactory {
  return {
    async create({ user, ...overrides } = {}) {
      const n = ctx.next('device');
      const userId = user === undefined ? (await users(ctx).create()).id : idOf(user);
      return ctx.db
        .insertInto('devices')
        .values({
          id: ctx.ids('dev'),
          user_id: userId,
          name: `Device ${n}`,
          platform: 'linux',
          x25519_pub: publicKey(ctx.bytes(32)),
          ed25519_pub: publicKey(ctx.bytes(32)),
          fingerprint: fingerprint(ctx.bytes(12)),
          ...ctx.at(),
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
  };
}

function sessions(ctx: Context): SessionFactory {
  return {
    async create({ workspace, createdBy, ...overrides } = {}) {
      const n = ctx.next('session');
      const ws = workspace === undefined ? await workspaces(ctx).create() : undefined;
      const workspaceId = ws?.id ?? idOf(workspace as Ref);
      let creator = createdBy === undefined ? ws?.created_by : idOf(createdBy);
      if (creator === undefined) {
        const row = await ctx.db
          .selectFrom('workspaces')
          .select('created_by')
          .where('id', '=', workspaceId)
          .executeTakeFirstOrThrow();
        creator = row.created_by;
      }
      return ctx.db
        .insertInto('sessions')
        .values({
          id: ctx.ids('ses'),
          workspace_id: workspaceId,
          name: `Session ${n}`,
          region: 'eu',
          created_by: creator,
          ...ctx.at(),
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
  };
}

function sessionMembers(ctx: Context): SessionMemberFactory {
  return {
    async create({ session, user, device, ...overrides }) {
      const sessionId = idOf(session);
      const userId = user === undefined ? (await users(ctx).create()).id : idOf(user);
      const deviceId =
        device === undefined ? (await devices(ctx).create({ user: userId })).id : idOf(device);
      const taken = await ctx.db
        .selectFrom('session_members')
        .select((eb) => eb.fn.max('slot').as('slot'))
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      const slot = taken?.slot === null || taken?.slot === undefined ? 0 : Number(taken.slot) + 1;
      const joined = ctx.at().created_at;
      return ctx.db
        .insertInto('session_members')
        .values({
          id: ctx.ids('mem'),
          session_id: sessionId,
          user_id: userId,
          device_id: deviceId,
          role: 'viewer',
          slot,
          ...(joined === undefined ? {} : { joined_at: joined }),
          ...overrides,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },
  };
}

/** Every factory over one database and one set of dependencies (shared ids, clock and random). */
export function createFactories(
  db: Db,
  deps: FactoryDeps = {},
): {
  users: UserFactory;
  workspaces: WorkspaceFactory;
  memberships: MembershipFactory;
  devices: DeviceFactory;
  sessions: SessionFactory;
  sessionMembers: SessionMemberFactory;
} {
  const ctx = context(db, deps);
  return {
    users: users(ctx),
    workspaces: workspaces(ctx),
    memberships: memberships(ctx),
    devices: devices(ctx),
    sessions: sessions(ctx),
    sessionMembers: sessionMembers(ctx),
  };
}

/** `userFactory(db).create(overrides?)`: one user. */
export const userFactory = (db: Db, deps: FactoryDeps = {}): UserFactory =>
  createFactories(db, deps).users;
/** `workspaceFactory(db).create({owner?})`: a workspace and its owner membership. */
export const workspaceFactory = (db: Db, deps: FactoryDeps = {}): WorkspaceFactory =>
  createFactories(db, deps).workspaces;
/** `membershipFactory(db).create({workspace, user?, role?})`. */
export const membershipFactory = (db: Db, deps: FactoryDeps = {}): MembershipFactory =>
  createFactories(db, deps).memberships;
/** `deviceFactory(db).create({user?})`: a device with random keys. */
export const deviceFactory = (db: Db, deps: FactoryDeps = {}): DeviceFactory =>
  createFactories(db, deps).devices;
/** `sessionFactory(db).create({workspace?, createdBy?})`. */
export const sessionFactory = (db: Db, deps: FactoryDeps = {}): SessionFactory =>
  createFactories(db, deps).sessions;
/** `sessionMemberFactory(db).create({session, user?, device?})`, in the next free slot. */
export const sessionMemberFactory = (db: Db, deps: FactoryDeps = {}): SessionMemberFactory =>
  createFactories(db, deps).sessionMembers;
