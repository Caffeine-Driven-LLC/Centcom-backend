/**
 * `pnpm dev:two-accounts` (B103): two brand-new accounts, from nothing, share a session on your
 * local stack. No seed data is used:
 *
 * 1. Alice and Bob each sign up with a new e-mail address (device code, the mailed link from
 *    Mailpit, approval in the browser pages). The first sign-in creates the account, a personal
 *    workspace with its owner membership, and (in development) a Team plan for it.
 * 2. Alice creates a session in her workspace and invites Bob's address; Bob accepts the invite
 *    with the token from the mail and joins the session through the relay.
 * 3. The host grants the keys; each sends an encrypted message the other reads.
 * 4. Alice also makes a share link, and a visitor without an account turns it into a viewer
 *    ticket (the API side; the relay does not admit guest tickets yet, so there is no more).
 *
 * Needs `pnpm dev:up`, `pnpm dev:api` and `pnpm dev:relay` running, and the client checked out
 * next to this repo (or CENTCOM_CLIENT_DIR). Exits 1 when a step failed.
 */
import { api, appToken, listen, signUp, until, type Person } from './client-kit.js';

const step = (text: string): void => console.log(`\n== ${text}`);
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) process.exitCode = 1;
};

async function rest<T>(
  who: Person,
  method: string,
  path: string,
  body?: unknown,
  token = who.token,
): Promise<T> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'idempotency-key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text === '' ? {} : JSON.parse(text)) as T;
}

step('Alice and Bob sign up');
const alice = await signUp('alice');
const bob = await signUp('bob');
for (const p of [alice, bob]) {
  const list = await rest<{ data: { id: string; name: string }[] }>(p, 'GET', '/v1/workspaces');
  const ws = list.data[0];
  check(
    list.data.length === 1 && ws !== undefined,
    `${p.email}: one personal workspace "${ws?.name}"`,
  );
  const ent = await rest<{ plan: string; limits: { relay_access: boolean } }>(
    p,
    'GET',
    `/v1/workspaces/${ws?.id}/entitlements`,
  );
  check(ent.limits.relay_access, `${p.email}: plan ${ent.plan}, relay access`);
}
const home =
  (await rest<{ data: { id: string }[] }>(alice, 'GET', '/v1/workspaces')).data[0]?.id ?? '';

step('Alice hosts a session and invites Bob');
const log: string[] = [];
const host = await alice.sessions.createSession({ name: 'fresh accounts', workspace: home });
listen(host, log, 'alice');
check(host.state === 'live', `session ${host.id} is live, Alice is ${host.me.role}`);
const invite = await rest<{ token: string; invite: { id: string } }>(
  alice,
  'POST',
  `/v1/workspaces/${home}/invites`,
  { email: bob.email, role: 'member' },
  // Inviting is the web app's job: a terminal's token has no `workspaces:write`.
  appToken(alice),
);
check(typeof invite.token === 'string', 'the invite carries a token (shown once)');
const accepted = await rest<{ workspace: { id: string } }>(
  bob,
  'POST',
  `/v1/invites/${invite.token}/accept`,
);
check(accepted.workspace.id === home, "Bob accepted: he is a member of Alice's workspace");

step('Bob joins through the relay and they talk');
const guest = await bob.sessions.joinSession({ sessionId: host.id });
listen(guest, log, 'bob');
check(
  await until(() => guest.state === 'live'),
  `Bob is ${guest.me.role} and ${guest.state} (keys granted)`,
);
await host.sendEvent('message.user', { secret: { text: 'welcome, Bob' } });
await guest.sendEvent('message.user', { secret: { text: 'thanks, Alice' } });
check(await until(() => log.length === 4, 5_000), 'both read both messages');
log.forEach((line) => console.log(`     ${line}`));

step('A share link for a visitor without an account (the API side)');
const link = await host.createShareLink();
check(link.fragment.startsWith('#k='), `Alice made a link (${link.url}, key in the fragment)`);
const joined = await fetch(`${api}/v1/share-links/${link.token}/join`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ display_name: 'Visitor' }),
});
const ticket = (await joined.json()) as { role?: string; ticket?: string; relay_url?: string };
check(
  joined.status === 200 && ticket.role === 'viewer' && typeof ticket.ticket === 'string',
  `the visitor gets a viewer ticket for ${ticket.relay_url ?? '?'}`,
);
console.log(
  '     (the relay does not admit guest tickets yet: they carry no device, which its handshake requires)',
);

await guest.leave();
await host.end();
console.log(process.exitCode === 1 ? '\nFAILED' : '\nOK: two new accounts shared a session');
process.exit(process.exitCode ?? 0);
