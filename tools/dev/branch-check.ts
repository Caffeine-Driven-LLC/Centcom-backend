/* eslint-disable @typescript-eslint/no-explicit-any -- the client's sources are loaded by path, untyped */
/**
 * `pnpm dev:branch-check` (B110): cross-computer collaboration, "branch mode". Two brand-new
 * accounts share one `branch` session and each runs their own agent through the real client
 * libraries; the script checks what the relay lets through and what it refuses.
 *
 * Needs `pnpm dev:up`, `dev:api` and `dev:relay` running, and the client checked out next to this
 * repo (or CENTCOM_CLIENT_DIR; board.* steps need a client built from the changed contracts, and
 * are skipped, and said to be, when its protocol package does not know `board.note`). Exits 1
 * when a step failed.
 */
import { randomBytes } from 'node:crypto';
import {
  api,
  appToken,
  listen,
  pause,
  sessionClientWithMode,
  signUp,
  until,
  type Person,
} from './client-kit.js';

const step = (text: string): void => console.log(`\n== ${text}`);
const check = (ok: boolean, text: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) process.exitCode = 1;
};
const note = (text: string): void => console.log(`     ${text}`);

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

/** Sends and reports 'ok' or the refusal's code (the relay answers `sys.error`; the client rejects). */
async function attempt(h: any, kind: string, body: Record<string, unknown>): Promise<string> {
  try {
    await Promise.race([
      h.sendEvent(kind, body),
      pause(4_000).then(() => {
        throw Object.assign(new Error('no answer'), { code: 'timeout' });
      }),
    ]);
    return 'ok';
  } catch (e: any) {
    return String(e?.code ?? e?.message ?? e);
  }
}

const mem = (h: any): string => h.me.id as string;
const agt = (): string =>
  `agt_${randomBytes(16)
    .toString('hex')
    .slice(0, 26)
    .toUpperCase()
    .replace(/[ILOU]/g, '7')}`;
const msg = (): string =>
  `msg_${randomBytes(16)
    .toString('hex')
    .slice(0, 26)
    .toUpperCase()
    .replace(/[ILOU]/g, '7')}`;
const apr = (): string =>
  `apr_${randomBytes(16)
    .toString('hex')
    .slice(0, 26)
    .toUpperCase()
    .replace(/[ILOU]/g, '7')}`;
const now = (): string => new Date().toISOString();

step('Alice and Bob sign up; Alice creates a BRANCH session, Bob joins');
const alice = await signUp('alice');
const bob = await signUp('bob');
const home =
  (await rest<{ data: { id: string }[] }>(alice, 'GET', '/v1/workspaces')).data[0]?.id ?? '';
// The client library's `createSession` has no mode option yet, so the check completes its request.
const hostHandle: any = await sessionClientWithMode(alice, 'branch').createSession({
  name: 'branch mode check',
  workspace: home,
});
const created = { id: hostHandle.id as string };
const info = await rest<{ mode?: string }>(alice, 'GET', `/v1/sessions/${created.id}`);
check(info.mode === 'branch', `the session was created with mode ${info.mode}`);
const plain = await rest<{ mode?: string }>(alice, 'POST', '/v1/sessions', {
  workspace: home,
  name: 'plain',
});
check(plain.mode === 'command_post', `without a mode the session is a ${plain.mode}`);
const invite = await rest<{ token: string }>(
  alice,
  'POST',
  `/v1/workspaces/${home}/invites`,
  { email: bob.email, role: 'member' },
  appToken(alice),
);
await rest(bob, 'POST', `/v1/invites/${invite.token}/accept`);
const guest = await bob.sessions.joinSession({ sessionId: created.id });
check(
  await until(() => guest.state === 'live' && hostHandle.state === 'live'),
  `both live: Alice ${hostHandle.me.role}, Bob ${guest.me.role}`,
);

const seenA: any[] = [];
const seenB: any[] = [];
hostHandle.onAny((e: any) => seenA.push(e));
guest.onAny((e: any) => seenB.push(e));
const got = (seen: any[], kind: string, pred: (e: any) => boolean = () => true): any =>
  seen.find((e) => e.kind === kind && pred(e));

step('Each member spawns their own agent (owner = themselves)');
const aliceAgent = agt();
const bobAgent = agt();
const spawn = (h: any, id: string, label: string, owner = mem(h)) =>
  attempt(h, 'agent.spawn', {
    p: { agent_id: id, owner, mode: 'branch', runs_on: mem(h), provider: 'anthropic' },
    secret: { label, branch: `agent/${label}`, worktree: `/tmp/${label}`, model: 'x' },
  });
check(
  (await spawn(hostHandle, aliceAgent, 'alice-agent')) === 'ok',
  "Alice's agent.spawn is accepted",
);
check(
  (await spawn(guest, bobAgent, 'bob-agent')) === 'ok',
  "Bob's agent.spawn (owner: Bob) is accepted",
);
check(
  await until(() => !!got(seenA, 'agent.spawn', (e) => e.p?.agent_id === bobAgent)),
  "Alice's client sees Bob's agent (relay fan-out)",
);
const stolen = await spawn(guest, agt(), 'steal', mem(hostHandle));
check(stolen === 'forbidden', `Bob cannot spawn an agent owned by Alice -> ${stolen}`);

step('Agent state, exit, ownership and rate limit');
const state = (h: any, id: string, s: string) =>
  attempt(h, 'agent.state', { p: { agent_id: id, state: s, since: now() } });
check((await state(guest, bobAgent, 'thinking')) === 'ok', 'Bob updates his own agent state');
const bobOnAlice = await state(guest, aliceAgent, 'thinking');
check(bobOnAlice === 'forbidden', `Bob cannot update Alice's agent -> ${bobOnAlice}`);
const exitOther = await attempt(guest, 'agent.exit', {
  p: { agent_id: aliceAgent, outcome: 'ok' },
});
check(exitOther === 'forbidden', `Bob cannot end Alice's agent -> ${exitOther}`);
check(
  (await state(hostHandle, bobAgent, 'editing-file')) === 'ok',
  'the host may update any agent',
);
step("Messages from the agent's owner, and the command-post rule");
check(
  (await attempt(guest, 'message.user', {
    secret: { text: 'bob asks his own agent', agent_id: bobAgent },
  })) === 'ok',
  'Bob sends message.user for his own agent (branch mode: the owner emits)',
);
check(
  (await attempt(guest, 'message.assistant.delta', {
    secret: { agent_id: bobAgent, message_id: msg(), index: 0, delta: 'hi' },
  })) === 'ok',
  'Bob streams message.assistant.delta for his agent',
);
const readA = await until(() => !!got(seenA, 'message.user', (e) => e.from === mem(guest)));
check(readA, "Alice's client decrypts Bob's message");
note(
  "(the command-post refusals are covered by the relay's tests; the live session above is branch)",
);
const spoof = await attempt(guest, 'message.user', {
  secret: { text: "pretending to be Alice's agent", agent_id: aliceAgent },
});
note(`Bob's message naming Alice's agent_id (inside ct): ${spoof}`);
check(
  spoof === 'ok',
  'KNOWN GAP (by design): the relay cannot see agent_id inside ct, so it accepts it; receivers must check the sender owns the agent',
);

step("Approvals: Bob's agent asks, the workspace owner decides");
const approval = apr();
check(
  (await attempt(guest, 'approval.request', {
    p: {
      approval_id: approval,
      agent_id: bobAgent,
      risk: 'medium',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      approver: 'owner',
    },
    secret: { summary: 'npm test', command: 'npm test', cwd: '/work' },
  })) === 'ok',
  "Bob's approval.request for his own agent is accepted",
);
const forged = await attempt(guest, 'approval.request', {
  p: {
    approval_id: apr(),
    agent_id: aliceAgent,
    risk: 'low',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    approver: 'any_editor',
  },
  secret: { summary: 'forged' },
});
check(
  forged === 'forbidden',
  `Bob cannot ask for an approval in Alice's agent's name -> ${forged}`,
);
check(
  await until(() => !!got(seenA, 'approval.request', (e) => e.p?.approval_id === approval)),
  'Alice (workspace owner) sees the request',
);
const selfApprove = await attempt(guest, 'approval.decision', {
  p: { approval_id: approval, decision: 'approve', scope: 'once' },
});
check(
  selfApprove === 'forbidden',
  `Bob cannot approve his own approver:"owner" request -> ${selfApprove}`,
);
check(
  (await attempt(hostHandle, 'approval.decision', {
    p: { approval_id: approval, decision: 'approve', scope: 'once' },
  })) === 'ok',
  'Alice approves it',
);
check(
  await until(() => !!got(seenB, 'approval.decision', (e) => e.p?.approval_id === approval)),
  "Bob's client receives the decision",
);

step("File locks and the relay's conflict signal");
const path = 'AAAA-branch-check-path';
const lockFrame = (id: string, action: string) => ({
  p: { action, path_hmac: path, agent_id: id, ttl_ms: 60_000 },
});
check(
  (await attempt(hostHandle, 'file.lock', lockFrame(aliceAgent, 'acquire'))) === 'ok',
  'Alice locks a path_hmac for her agent',
);
const impersonate = await attempt(guest, 'file.lock', lockFrame(aliceAgent, 'acquire'));
check(impersonate === 'forbidden', `Bob cannot lock in Alice's agent's name -> ${impersonate}`);
await attempt(guest, 'file.lock', lockFrame(bobAgent, 'acquire'));
check(
  await until(() => !!got(seenA, 'conflict.detected') || !!got(seenB, 'conflict.detected'), 6_000),
  "the relay emits conflict.detected when Bob's agent asks for Alice's locked path (no path leaves the clients)",
);
const conflict = got(seenA, 'conflict.detected') ?? got(seenB, 'conflict.detected');
check(
  conflict === undefined ||
    (Array.isArray(conflict.p?.agent_ids) &&
      conflict.p.agent_ids.length === 2 &&
      !('paths' in (conflict.p ?? {}))),
  'conflict.detected names both agents and carries hashes only',
);
check(
  (await attempt(hostHandle, 'file.lock', lockFrame(aliceAgent, 'release'))) === 'ok',
  'Alice releases',
);

step('Handoff and presence');
const offerBobsAgent = await attempt(hostHandle, 'agent.handoff', {
  p: { handoff: msg(), agent_id: bobAgent, to: mem(hostHandle), op: 'offer' },
});
check(offerBobsAgent === 'ok', 'the host may offer any agent');
const bobOffersAlices = await attempt(guest, 'agent.handoff', {
  p: { handoff: msg(), agent_id: aliceAgent, to: mem(guest), op: 'offer' },
});
check(
  bobOffersAlices === 'forbidden',
  `Bob cannot offer Alice's agent to himself -> ${bobOffersAlices}`,
);
check(
  (await attempt(guest, 'presence.update', {
    p: { status: 'online', activity: 'running', agent_count: 1 },
  })) === 'ok',
  'presence.update with agent_count is accepted',
);
check(
  await until(() => !!got(seenA, 'presence.update', (e) => e.from === mem(guest))),
  "Alice sees Bob's presence",
);

step('Exit, then a late joiner replays the session');
check(
  (await attempt(guest, 'agent.exit', { p: { agent_id: bobAgent, outcome: 'ok' } })) === 'ok',
  'Bob ends his own agent',
);
await pause(500);
const late = await rest<{ data: unknown[] }>(
  alice,
  'GET',
  `/v1/sessions/${created.id}/history`,
).catch(() => undefined);
if (late === undefined)
  note(
    '(GET /v1/sessions/{id}/history is not served by this API build: replay is checked by dev:replay-check)',
  );
else check(late.data.length > 0, `history has ${late.data.length} frames for a late joiner`);

step('Board notes (board.note, board.pin, board.remove)');
const known = await attempt(hostHandle, 'board.note', {
  p: { type: 'decision' },
  secret: { text: 'branch check note' },
});
if (known === 'unknown event kind board.note' || known.includes('unknown event kind')) {
  note(
    'SKIPPED: this client does not know board.note (use CENTCOM_CLIENT_DIR with the changed contracts)',
  );
} else {
  check(known === 'ok', `Alice adds a note -> ${known}`);
  check(
    await until(() => !!got(seenB, 'board.note')),
    "Bob's client receives and decrypts the note",
  );
  const noteId = got(seenB, 'board.note')?.id as string | undefined;
  check(
    (await attempt(guest, 'board.pin', { p: { note: noteId, pinned: true } })) === 'ok',
    'an editor may pin',
  );
  const removeOther = await attempt(guest, 'board.remove', { p: { note: noteId } });
  check(removeOther === 'forbidden', `an editor cannot remove the host's note -> ${removeOther}`);
  check(
    (await attempt(hostHandle, 'board.remove', { p: { note: noteId } })) === 'ok',
    'the host removes it',
  );
  const unknownPin = await attempt(guest, 'board.pin', { p: { note: msg(), pinned: true } });
  check(unknownPin === 'invalid_frame', `pinning an unknown note -> ${unknownPin}`);
  let accepted = 0;
  let limited = '';
  for (let i = 0; i < 25; i += 1) {
    const r = await attempt(guest, 'board.note', {
      p: { type: 'finding' },
      secret: { text: `note ${i}` },
    });
    if (r === 'ok') accepted += 1;
    else limited = r;
  }
  check(
    accepted === 20 && limited === 'frame_rate_exceeded',
    `20 notes an hour per member: ${accepted} accepted, then ${limited}`,
  );
}

step('Rate limit: agent.state, at most 2 a second per agent');
step("Messages from the agent's owner, and the command-post rule");
check(
  (await attempt(guest, 'message.user', {
    secret: { text: 'bob asks his own agent', agent_id: bobAgent },
  })) === 'ok',
  'Bob sends message.user for his own agent (branch mode: the owner emits)',
);
check(
  (await attempt(guest, 'message.assistant.delta', {
    secret: { agent_id: bobAgent, message_id: msg(), index: 0, delta: 'hi' },
  })) === 'ok',
  'Bob streams message.assistant.delta for his agent',
);
const readA = await until(() => !!got(seenA, 'message.user', (e) => e.from === mem(guest)));
check(readA, "Alice's client decrypts Bob's message");
note(
  "(the command-post refusals are covered by the relay's tests; the live session above is branch)",
);
const spoof = await attempt(guest, 'message.user', {
  secret: { text: "pretending to be Alice's agent", agent_id: aliceAgent },
});
note(`Bob's message naming Alice's agent_id (inside ct): ${spoof}`);
check(
  spoof === 'ok',
  'KNOWN GAP (by design): the relay cannot see agent_id inside ct, so it accepts it; receivers must check the sender owns the agent',
);

step("Approvals: Bob's agent asks, the workspace owner decides");
const approval = apr();
check(
  (await attempt(guest, 'approval.request', {
    p: {
      approval_id: approval,
      agent_id: bobAgent,
      risk: 'medium',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      approver: 'owner',
    },
    secret: { summary: 'npm test', command: 'npm test', cwd: '/work' },
  })) === 'ok',
  "Bob's approval.request for his own agent is accepted",
);
const forged = await attempt(guest, 'approval.request', {
  p: {
    approval_id: apr(),
    agent_id: aliceAgent,
    risk: 'low',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    approver: 'any_editor',
  },
  secret: { summary: 'forged' },
});
check(
  forged === 'forbidden',
  `Bob cannot ask for an approval in Alice's agent's name -> ${forged}`,
);
check(
  await until(() => !!got(seenA, 'approval.request', (e) => e.p?.approval_id === approval)),
  'Alice (workspace owner) sees the request',
);
const selfApprove = await attempt(guest, 'approval.decision', {
  p: { approval_id: approval, decision: 'approve', scope: 'once' },
});
check(
  selfApprove === 'forbidden',
  `Bob cannot approve his own approver:"owner" request -> ${selfApprove}`,
);
check(
  (await attempt(hostHandle, 'approval.decision', {
    p: { approval_id: approval, decision: 'approve', scope: 'once' },
  })) === 'ok',
  'Alice approves it',
);
check(
  await until(() => !!got(seenB, 'approval.decision', (e) => e.p?.approval_id === approval)),
  "Bob's client receives the decision",
);

step("File locks and the relay's conflict signal");
const path = 'AAAA-branch-check-path';
const lockFrame = (id: string, action: string) => ({
  p: { action, path_hmac: path, agent_id: id, ttl_ms: 60_000 },
});
check(
  (await attempt(hostHandle, 'file.lock', lockFrame(aliceAgent, 'acquire'))) === 'ok',
  'Alice locks a path_hmac for her agent',
);
const impersonate = await attempt(guest, 'file.lock', lockFrame(aliceAgent, 'acquire'));
check(impersonate === 'forbidden', `Bob cannot lock in Alice's agent's name -> ${impersonate}`);
await attempt(guest, 'file.lock', lockFrame(bobAgent, 'acquire'));
check(
  await until(() => !!got(seenA, 'conflict.detected') || !!got(seenB, 'conflict.detected'), 6_000),
  "the relay emits conflict.detected when Bob's agent asks for Alice's locked path (no path leaves the clients)",
);
const conflict = got(seenA, 'conflict.detected') ?? got(seenB, 'conflict.detected');
check(
  conflict === undefined ||
    (Array.isArray(conflict.p?.agent_ids) &&
      conflict.p.agent_ids.length === 2 &&
      !('paths' in (conflict.p ?? {}))),
  'conflict.detected names both agents and carries hashes only',
);
check(
  (await attempt(hostHandle, 'file.lock', lockFrame(aliceAgent, 'release'))) === 'ok',
  'Alice releases',
);

step('Handoff and presence');
const offerBobsAgent = await attempt(hostHandle, 'agent.handoff', {
  p: { handoff: msg(), agent_id: bobAgent, to: mem(hostHandle), op: 'offer' },
});
check(offerBobsAgent === 'ok', 'the host may offer any agent');
const bobOffersAlices = await attempt(guest, 'agent.handoff', {
  p: { handoff: msg(), agent_id: aliceAgent, to: mem(guest), op: 'offer' },
});
check(
  bobOffersAlices === 'forbidden',
  `Bob cannot offer Alice's agent to himself -> ${bobOffersAlices}`,
);
check(
  (await attempt(guest, 'presence.update', {
    p: { status: 'online', activity: 'running', agent_count: 1 },
  })) === 'ok',
  'presence.update with agent_count is accepted',
);
check(
  await until(() => !!got(seenA, 'presence.update', (e) => e.from === mem(guest))),
  "Alice sees Bob's presence",
);

step('Exit, then a late joiner replays the session');
check(
  (await attempt(guest, 'agent.exit', { p: { agent_id: bobAgent, outcome: 'ok' } })) === 'ok',
  'Bob ends his own agent',
);
await pause(500);
const late = await rest<{ data: unknown[] }>(
  alice,
  'GET',
  `/v1/sessions/${created.id}/history`,
).catch(() => undefined);
if (late === undefined)
  note(
    '(GET /v1/sessions/{id}/history is not served by this API build: replay is checked by dev:replay-check)',
  );
else check(late.data.length > 0, `history has ${late.data.length} frames for a late joiner`);

step('Board notes (board.note, board.pin, board.remove)');
const known = await attempt(hostHandle, 'board.note', {
  p: { type: 'decision' },
  secret: { text: 'branch check note' },
});
if (known === 'unknown event kind board.note' || known.includes('unknown event kind')) {
  note(
    'SKIPPED: this client does not know board.note (use CENTCOM_CLIENT_DIR with the changed contracts)',
  );
} else {
  check(known === 'ok', `Alice adds a note -> ${known}`);
  check(
    await until(() => !!got(seenB, 'board.note')),
    "Bob's client receives and decrypts the note",
  );
  const noteId = got(seenB, 'board.note')?.id as string | undefined;
  check(
    (await attempt(guest, 'board.pin', { p: { note: noteId, pinned: true } })) === 'ok',
    'an editor may pin',
  );
  const removeOther = await attempt(guest, 'board.remove', { p: { note: noteId } });
  check(removeOther === 'forbidden', `an editor cannot remove the host's note -> ${removeOther}`);
  check(
    (await attempt(hostHandle, 'board.remove', { p: { note: noteId } })) === 'ok',
    'the host removes it',
  );
  const unknownPin = await attempt(guest, 'board.pin', { p: { note: msg(), pinned: true } });
  check(unknownPin === 'invalid_frame', `pinning an unknown note -> ${unknownPin}`);
  let accepted = 0;
  let limited = '';
  for (let i = 0; i < 25; i += 1) {
    const r = await attempt(guest, 'board.note', {
      p: { type: 'finding' },
      secret: { text: `note ${i}` },
    });
    if (r === 'ok') accepted += 1;
    else limited = r;
  }
  check(
    accepted === 20 && limited === 'frame_rate_exceeded',
    `20 notes an hour per member: ${accepted} accepted, then ${limited}`,
  );
}

step('Rate limit: agent.state, at most 2 a second per agent');
let burst = 0;
const names = [
  'thinking',
  'reading-file',
  'editing-file',
  'searching',
  'planning',
  'thinking-hard',
];
for (let i = 0; i < 8; i += 1)
  if ((await state(guest, bobAgent, names[i % names.length] ?? 'idle')) === 'ok') burst += 1;
note(
  `8 agent.state frames in a burst: ${burst} accepted (the relay drops more than 2 per second per agent silently)`,
);

step('Rate limit: agent.state, at most 2 a second per agent');

await hostHandle.leave();
await guest.leave();
void listen;
console.log(process.exitCode === 1 ? '\nFAILED' : '\nOK: branch mode checked');
