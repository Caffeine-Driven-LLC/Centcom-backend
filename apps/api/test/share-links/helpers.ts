/**
 * Test helpers for share links (B068): B054's session harness (the API's plugin stack, B053's real
 * service, B017's real token service with Ed25519 test keys, an in-memory world) with the
 * share-link routes added. The share-link store is in memory with the Postgres store's rules:
 * - links are found by hash;
 * - a use is spent under one lock (`consume`), and a failing step rolls it back;
 * - revoke deletes the link's guests;
 * - guests count as members.
 *
 * The relay notifier is recorded (and can fail).
 */
import { newId } from '@centcom/contracts';
import {
  ShareLinkService,
  type ShareLinkRecord,
  type ShareLinkServiceDeps,
  type ShareLinkStore,
} from '../../src/modules/share-links/index.js';
import { registerShareLinkRoutes, standingOf } from '../../src/routes/share-links/index.js';
import { sessionsApp, World } from '../routes/sessions/helpers.js';

export { T0 } from '../routes/sessions/helpers.js';

interface Guest {
  memberId: string;
  sessionId: string;
  linkId: string;
  name: string;
  slot: number;
}

/** The share-link store in memory over `world`. */
export function memoryShareLinkStore(world: World) {
  const links = new Map<string, ShareLinkRecord>();
  const guests: Guest[] = [];
  let turn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = turn.then(fn, fn);
    turn = result.catch(() => undefined);
    return result;
  };
  const store: ShareLinkStore & { links: typeof links; guests: Guest[] } = {
    links,
    guests,
    create(link) {
      const record: ShareLinkRecord = {
        ...link,
        id: crypto.randomUUID(),
        uses: 0,
        revokedAt: null,
      };
      links.set(record.id, record);
      return Promise.resolve({ ...record });
    },
    findByHash(hash) {
      const found = [...links.values()].find((l) => l.tokenHash.equals(hash));
      return Promise.resolve(found === undefined ? null : { ...found });
    },
    session(sessionId) {
      const s = world.sessions.get(sessionId);
      if (s === undefined) return Promise.resolve(null);
      return Promise.resolve({
        id: s.row.id,
        workspaceId: s.row.workspace_id,
        state: s.row.state,
        region: s.row.region,
        locked: s.policy?.locked ?? false,
      });
    },
    countMembers(sessionId) {
      const live = world.members.filter((m) => m.sessionId === sessionId && m.leftAt === null);
      return Promise.resolve(live.length + guests.filter((g) => g.sessionId === sessionId).length);
    },
    consume(linkId, now, guest, step) {
      return exclusive(async () => {
        const link = links.get(linkId);
        if (
          link === undefined ||
          link.revokedAt !== null ||
          link.expiresAt.getTime() <= now.getTime() ||
          link.uses >= link.maxUses
        ) {
          return { ok: false as const };
        }
        link.uses += 1;
        guests.push({ ...guest, linkId });
        try {
          return { ok: true as const, value: await step() };
        } catch (err) {
          link.uses -= 1;
          guests.splice(
            guests.findIndex((g) => g.memberId === guest.memberId),
            1,
          );
          throw err;
        }
      });
    },
    releaseSlot(sessionId, memberId) {
      world.slots.get(sessionId)?.delete(memberId);
      world.released.push(memberId);
      return Promise.resolve();
    },
    revoke(sessionId, hash, at) {
      return exclusive(() => {
        const link = [...links.values()].find(
          (l) => l.sessionId === sessionId && l.tokenHash.equals(hash),
        );
        if (link === undefined) return Promise.resolve(null);
        if (link.revokedAt === null) link.revokedAt = at;
        const gone = guests.filter((g) => g.linkId === link.id).map((g) => g.memberId);
        for (const id of gone)
          guests.splice(
            guests.findIndex((g) => g.memberId === id),
            1,
          );
        return Promise.resolve({ link: { ...link }, guests: gone });
      });
    },
    sweep(now) {
      const over = (g: Guest) => {
        const link = links.get(g.linkId);
        const state = world.sessions.get(g.sessionId)?.row.state;
        return (
          link === undefined ||
          link.expiresAt.getTime() <= now.getTime() ||
          state === 'ended' ||
          state === 'expired'
        );
      };
      const gone = guests.filter(over);
      for (const g of gone) guests.splice(guests.indexOf(g), 1);
      const by = new Map<string, string[]>();
      for (const g of gone) by.set(g.sessionId, [...(by.get(g.sessionId) ?? []), g.memberId]);
      return Promise.resolve([...by].map(([sessionId, memberIds]) => ({ sessionId, memberIds })));
    },
  };
  return store;
}

/** The session routes plus the share-link routes, over a fresh world. */
export async function shareApp(opts: { service?: Partial<ShareLinkServiceDeps> } = {}) {
  const world = new World();
  const store = memoryShareLinkStore(world);
  const closed: { sid: string; members: string[] }[] = [];
  const shareFlags = { failNotifier: false, failSigning: false };
  const holder: { service?: ShareLinkService } = {};
  const h = await sessionsApp({
    world,
    extra(app, { deps, redis, emitter, tokens }) {
      const service = new ShareLinkService({
        store,
        standing: standingOf(deps.store),
        slots: deps.slots,
        entitlements: deps.entitlements,
        tickets: {
          mintGuestRelayTicket: (claims) =>
            shareFlags.failSigning
              ? Promise.reject(new Error('no signing key'))
              : tokens.mintGuestRelayTicket(claims),
        },
        issued: deps.issued,
        relays: deps.relays,
        notifier: {
          closeGuests(sid, members) {
            if (shareFlags.failNotifier) return Promise.reject(new Error('relay down'));
            closed.push({ sid, members: [...members] });
            return Promise.resolve();
          },
        },
        rateLimit: redis.rateLimit,
        audit: emitter,
        clock: deps.clock ?? Date.now,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
        ...opts.service,
      });
      holder.service = service;
      registerShareLinkRoutes(app, { service });
    },
  });
  const service = holder.service;
  if (service === undefined) throw new Error('no share-link service');

  /** A team workspace whose owner hosts a new session, with its member in it as an editor. */
  async function session() {
    const w = world.workspace('team');
    const host = w.owner;
    const s = await h.create(host, w.id);
    const editor = w.member;
    world.addMember(s.id, editor, 'editor');
    return { w, workspace: w.id, host, editor, sid: s.id };
  }

  /** Creates a link as `who` (default the host); the response. */
  async function create(
    sid: string,
    who: { user: string; device: string },
    body: Record<string, unknown> = {},
  ) {
    return h.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sid}/share-links`,
      headers: await h.as(who),
      payload: body,
    });
  }

  /** Joins through `token` from `ip`. */
  function join(
    token: string,
    body: Record<string, unknown> = { display_name: 'Guest' },
    ip = '203.0.113.7',
  ) {
    return h.app.inject({
      method: 'POST',
      url: `/v1/share-links/${token}/join`,
      payload: body,
      remoteAddress: ip,
    });
  }

  /** Revokes `token` as `who`. */
  async function revoke(sid: string, token: string, who: { user: string; device: string }) {
    return h.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sid}/share-links/${token}`,
      headers: await h.as(who),
    });
  }

  /** The claims of a JWT. */
  const claims = (jwt: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

  /** A fresh client address (each test's own rate-limit bucket). */
  const ip = (): string => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

  return {
    ...h,
    store,
    service,
    closed,
    shareFlags,
    session,
    create,
    join,
    revoke,
    claims,
    ip,
    newId,
  };
}
