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
 * 4. Alice also makes a share link; a visitor with no account and no device joins by it as a
 *    viewer (a ticket without a `dev` claim, a `guest_member` row) and reads what Alice sends.
 *
 * Needs `pnpm dev:up`, `pnpm dev:api` and `pnpm dev:relay` running, and the client checked out
 * next to this repo (or CENTCOM_CLIENT_DIR). Exits 1 when a step failed.
 */
import {
  api,
  appToken,
  clientInfo,
  listen,
  net,
  relay,
  signUp,
  until,
  type Person,
} from './client-kit.js';

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

step('Carol, from another workspace, joins this one session by a session invite (no seat)');
const carol = await signUp('carol');
const before = await rest<{ data: { id: string }[] }>(
  alice,
  'GET',
  `/v1/workspaces/${home}/members`,
);
const session = await rest<{ token: string; session: string; role: string }>(
  alice,
  'POST',
  `/v1/sessions/${host.id}/invites`,
  { email: carol.email, role: 'editor' },
);
check(
  session.session === host.id && session.role === 'editor',
  'Alice invited Carol to this session only',
);
const acceptedSession = await rest<{ session: string; role: string; workspace: string }>(
  carol,
  'POST',
  `/v1/invites/${session.token}/accept`,
);
check(
  acceptedSession.session === host.id && acceptedSession.workspace === home,
  'Carol accepted: the right to join this session',
);
const after = await rest<{ data: { id: string }[] }>(
  alice,
  'GET',
  `/v1/workspaces/${home}/members`,
);
check(
  after.data.length === before.data.length,
  "Carol is not a member of Alice's workspace (no seat used)",
);
const carolSession = await carol.sessions.joinSession({ sessionId: host.id });
listen(carolSession, log, 'carol');
check(
  await until(() => carolSession.state === 'live'),
  `Carol is ${carolSession.me.role} and ${carolSession.state} (keys granted)`,
);
await host.sendEvent('message.user', { secret: { text: 'hi, Carol' } });
check(
  await until(
    () => log.filter((l) => l.startsWith('carol') && l.includes('hi, Carol')).length === 1,
    5_000,
  ),
  'Carol reads the host',
);
await carolSession.leave();

step('A visitor without an account joins by the share link');
const link = await host.createShareLink();
check(link.fragment.startsWith('#k='), `Alice made a link (${link.url}, key in the fragment)`);
// The visitor has no account: no token, no device. The link's token buys a viewer ticket (no `dev`
// claim) and the relay admits it. (The client's own `joinViaShareLink` still fetches a member join
// token for its relay ticket, so this connects at the protocol level.)
const joined = await fetch(`${api}/v1/share-links/${link.token}/join`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ display_name: 'Visitor' }),
});
const grant = (await joined.json()) as { ticket: string; relay_url: string; role: string };
check(joined.status === 200 && grant.role === 'viewer', 'the link gives a viewer ticket');
const keyList = await fetch(`${api}/v1/share-links/${link.token}/members`);
const keys = (await keyList.json()) as {
  data: { user?: string; device_keys?: { ed25519?: string } }[];
};
check(
  keyList.status === 200 &&
    keys.data.length >= 2 &&
    keys.data.every((m) => m.device_keys?.ed25519 !== undefined && m.user === undefined),
  `the link also gives the ${keys.data.length} members' public keys (no user ids), so a guest can check who signed`,
);
const visitor = new net.RelayClient({
  url: relay,
  sessionId: host.id,
  clientInfo,
  allowPlainWs: true,
  getTicket: () => Promise.resolve({ ticket: grant.ticket, url: grant.relay_url }),
});
const seen: string[] = [];
visitor.on('frame', (f: { k?: string; ct?: unknown }) => {
  if (f.k === 'message.user' && f.ct !== undefined) seen.push(f.k);
});
const welcome = await visitor.connect();
check(
  welcome.role === 'viewer' && welcome.member.name === 'Visitor',
  `the relay welcomed "${welcome.member.name}" as a ${welcome.role} (slot ${welcome.slot}), no device`,
);
await host.sendEvent('message.user', { secret: { text: 'hello visitor' } });
check(await until(() => seen.length === 1, 5_000), 'the visitor receives the encrypted message');
const refused = await visitor
  .send({ t: 'event', id: net.newMsgId?.() ?? 'msg_01M4QHTAGZVY7KN32ADY0ABQ39', k: 'message.user' })
  .then(
    () => 'sent',
    () => 'refused',
  );
console.log(`     a viewer sending a message: ${refused}`);

await visitor.close(1000);
await guest.leave();
await host.end();
console.log(process.exitCode === 1 ? '\nFAILED' : '\nOK: two new accounts shared a session');
process.exit(process.exitCode ?? 0);
