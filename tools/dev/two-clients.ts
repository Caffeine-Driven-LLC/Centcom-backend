/**
 * `pnpm dev:two-clients` (B103): two people share one session through your local stack, using the
 * client's own libraries (../Centcom, `packages/net`), end to end: the host (the seeded owner on
 * their seeded laptop) creates a session on the API, the member joins it through the relay, the
 * host grants the session keys, and each sends an encrypted message the other reads.
 *
 * Needs `pnpm dev:up`, `pnpm dev:api` and `pnpm dev:relay` running, and the client checked out
 * next to this repo (or CENTCOM_CLIENT_DIR). Prints what happened; exits 1 when a step failed.
 * The people and their device keys come from the dev seed (tools/dev/seed.ts), so no sign-in is
 * needed; `pnpm dev:token` mints their access tokens.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the client's sources are loaded by path, untyped */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const clientDir = resolve(process.env['CENTCOM_CLIENT_DIR'] ?? resolve(here, '../../../Centcom'));
const api = process.env['PUBLIC_API_URL'] ?? 'http://localhost:3000';
const relay = process.env['RELAY_PUBLIC_URL'] ?? 'ws://localhost:8088/v1/ws';
const workspace = 'wsp_01KDVDNA00DEVSEED000000001';

// The client's libraries are TypeScript sources; run this file with tsx (the script does).
const net: any = await import(resolve(clientDir, 'packages/net/src/index.ts'));
const { initCrypto, sodium, b64, createHttpClient, createSessionClient, DeviceKeyStore } = net;
const { TrustStore, memoryKeychain, defaultUserAgent } = net;
await initCrypto();

/** A client acting as a seeded person on their seeded device. */
async function person(who: 'owner' | 'member', device: string): Promise<any> {
  const out = execFileSync('pnpm', ['-s', 'dev:token', who], {
    cwd: resolve(here, '../..'),
    encoding: 'utf8',
  });
  const token = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
    access_token: string;
    device: string;
  };
  // The seed's key halves: the SHA-256 of a public label (see seedDevicePrivateKey).
  const raw = (kind: string): Uint8Array =>
    new Uint8Array(
      createHash('sha256').update(`centcom dev-only test key/${device}/${kind}`).digest(),
    );
  const s = sodium();
  const xSecret = raw('x25519');
  const signing = s.crypto_sign_seed_keypair(raw('ed25519'));
  const keychain = memoryKeychain();
  await keychain.set(
    `device-keys:${token.device}`,
    JSON.stringify({
      v: 1,
      x_sk: b64(xSecret),
      x_pk: b64(s.crypto_scalarmult_base(xSecret)),
      s_sk: b64(signing.privateKey),
      s_pk: b64(signing.publicKey),
    }),
  );
  const keys = new DeviceKeyStore(keychain, token.device);
  await keys.getOrCreatePublicKeys();
  return createSessionClient({
    http: createHttpClient({
      baseUrl: api,
      userAgent: defaultUserAgent('0.0.0'),
      getAccessToken: () => Promise.resolve(token.access_token),
    }),
    crypto: { device: keys, trust: new TrustStore(), keychain },
    deviceId: token.device,
    clientInfo: { name: 'centcom-cli', version: '0.0.0', contract: '1.0' },
    relayUrl: relay,
    allowPlainWs: true,
  });
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const heard = (name: string, h: any, into: string[]): void =>
  h.onAny((e: any) => {
    if (e.kind === 'message.user') into.push(`${name} read: ${String(e.secret?.text)}`);
  });

const host = await (
  await person('owner', 'owner-laptop')
).createSession({
  name: 'two clients',
  workspace,
});
console.log(`host   ${host.me.role} in ${host.id} (${host.state})`);
const log: string[] = [];
heard('host', host, log);
const guest = await (await person('member', 'member-desktop')).joinSession({ sessionId: host.id });
heard('guest', guest, log);
console.log(`guest  ${guest.me.role} joined (${guest.state}), waiting for the host's keys`);
for (let i = 0; i < 40 && guest.state !== 'live'; i++) await pause(250);
console.log(`guest  ${guest.state}`);
await host.sendEvent('message.user', { secret: { text: 'hello from the host' } });
await guest.sendEvent('message.user', { secret: { text: 'hello from the guest' } });
await pause(1500);
log.forEach((line) => console.log(line));
console.log(
  `roster ${host
    .roster()
    .map((m: any) => `${m.name}:${m.role}`)
    .join(', ')}`,
);
await guest.leave();
await host.end();
const ok = log.length === 4 && guest.state !== 'waiting_for_key';
console.log(ok ? 'OK: both clients read both messages' : 'FAILED: messages were lost');
process.exit(ok ? 0 : 1);
