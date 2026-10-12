/**
 * `pnpm dev:two-clients` (B103): two people share one session through your local stack, using the
 * client's own libraries (../Centcom, `packages/net`), end to end: the host (the seeded owner on
 * their seeded laptop) creates a session on the API, the member joins it through the relay, the
 * host grants the session keys, and each sends an encrypted message the other reads.
 *
 * Needs `pnpm dev:up`, `pnpm dev:api` and `pnpm dev:relay` running, and the client checked out
 * next to this repo (or CENTCOM_CLIENT_DIR). Exits 1 when a step failed. The people and their
 * device keys come from the dev seed, so no sign-in is needed. For brand-new accounts see
 * `pnpm dev:two-accounts`.
 */
import { listen, seeded, until } from './client-kit.js';

const workspace = 'wsp_01KDVDNA00DEVSEED000000001';
const owner = await seeded('owner', 'owner-laptop');
const member = await seeded('member', 'member-desktop');

const log: string[] = [];
const host = await owner.sessions.createSession({ name: 'two clients', workspace });
console.log(`host   ${host.me.role} in ${host.id} (${host.state})`);
listen(host, log, 'host');
const guest = await member.sessions.joinSession({ sessionId: host.id });
listen(guest, log, 'guest');
console.log(`guest  ${guest.me.role} joined (${guest.state}), waiting for the host's keys`);
await until(() => guest.state === 'live');
console.log(`guest  ${guest.state}`);
await host.sendEvent('message.user', { secret: { text: 'hello from the host' } });
await guest.sendEvent('message.user', { secret: { text: 'hello from the guest' } });
await until(() => log.length === 4, 5_000);
log.forEach((line) => console.log(line));
console.log(
  `roster ${host
    .roster()
    .map((m: { name: string; role: string }) => `${m.name}:${m.role}`)
    .join(', ')}`,
);
await guest.leave();
await host.end();
const ok = log.length === 4 && guest.state !== 'waiting_for_key';
console.log(ok ? 'OK: both clients read both messages' : 'FAILED: messages were lost');
process.exit(ok ? 0 : 1);
