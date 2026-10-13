/* eslint-disable @typescript-eslint/no-explicit-any -- the client's sources are loaded by path, untyped */
/**
 * What the local checks share (B103): the client's libraries (`../Centcom/packages/net`, or
 * CENTCOM_CLIENT_DIR), people who act as the seeded users, and brand-new accounts that sign up
 * the way a terminal does (device code, a mailed link read from Mailpit, approval in the browser
 * pages). Used by `two-clients.ts` and `two-accounts.ts`.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const here = import.meta.dirname;
export const api = process.env['PUBLIC_API_URL'] ?? 'http://localhost:3000';
export const relay = process.env['RELAY_PUBLIC_URL'] ?? 'ws://localhost:8088/v1/ws';
export const mailpit = process.env['DEV_MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
const clientDir = resolve(process.env['CENTCOM_CLIENT_DIR'] ?? resolve(here, '../../../Centcom'));

export const net: any = await import(resolve(clientDir, 'packages/net/src/index.ts'));
await net.initCrypto();

export const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const clientInfo = { name: 'centcom-cli', version: '0.0.0', contract: '1.0' };

/** A person: their session client, REST client and device. */
export interface Person {
  name: string;
  userId: string;
  deviceId: string;
  http: any;
  sessions: any;
  token: string;
}

function makePerson(
  name: string,
  userId: string,
  deviceId: string,
  token: string,
  keys: any,
  keychain: any,
): Person {
  const http = net.createHttpClient({
    baseUrl: api,
    userAgent: net.defaultUserAgent('0.0.0'),
    getAccessToken: () => Promise.resolve(token),
  });
  const sessions = net.createSessionClient({
    http,
    crypto: { device: keys, trust: new net.TrustStore(), keychain },
    deviceId,
    clientInfo,
    relayUrl: relay,
    allowPlainWs: true,
  });
  return { name, userId, deviceId, http, sessions, token };
}

/** A seeded person (owner or member) on their seeded device; no sign-in needed. */
export async function seeded(who: 'owner' | 'member', device: string): Promise<Person> {
  const out = execFileSync('pnpm', ['-s', 'dev:token', who], {
    cwd: resolve(here, '../..'),
    encoding: 'utf8',
  });
  const token = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
    access_token: string;
    user: string;
    device: string;
  };
  // The seed's key halves: the SHA-256 of a public label (see seedDevicePrivateKey).
  const raw = (kind: string): Uint8Array =>
    new Uint8Array(
      createHash('sha256').update(`centcom dev-only test key/${device}/${kind}`).digest(),
    );
  const s = net.sodium();
  const xSecret = raw('x25519');
  const signing = s.crypto_sign_seed_keypair(raw('ed25519'));
  const keychain = net.memoryKeychain();
  await keychain.set(
    `device-keys:${token.device}`,
    JSON.stringify({
      v: 1,
      x_sk: net.b64(xSecret),
      x_pk: net.b64(s.crypto_scalarmult_base(xSecret)),
      s_sk: net.b64(signing.privateKey),
      s_pk: net.b64(signing.publicKey),
    }),
  );
  const keys = new net.DeviceKeyStore(keychain, token.device);
  await keys.getOrCreatePublicKeys();
  return makePerson(who, token.user, token.device, token.access_token, keys, keychain);
}

/** A tiny browser: cookies kept by name, redirects left to the caller. */
class Browser {
  private readonly jar = new Map<string, string>();
  private keep(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split('; ');
      const eq = pair.indexOf('=');
      const value = pair.slice(eq + 1);
      if (value === '' || attrs.some((a) => a.toLowerCase() === 'max-age=0')) {
        this.jar.delete(pair.slice(0, eq));
      } else this.jar.set(pair.slice(0, eq), value);
    }
  }
  async send(url: string, init: RequestInit = {}): Promise<{ res: Response; body: string }> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url.startsWith('http') ? url : `${api}${url}`, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) },
    });
    this.keep(res);
    return { res, body: await res.text() };
  }
  post(url: string, form: Record<string, string>) {
    return this.send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }
}

const hidden = (html: string, name: string): string => {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match?.[1] === undefined) throw new Error(`no field ${name} in the page`);
  return match[1].replace(/&amp;/g, '&');
};

/** The newest mail to `email` in Mailpit: its first link. */
async function mailedLink(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const found = (await (
      await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as { messages?: { ID: string }[] };
    const id = found.messages?.[0]?.ID;
    if (id !== undefined) {
      const mail = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as {
        Text: string;
      };
      const link = /https?:\/\/\S+/.exec(mail.Text)?.[0];
      if (link !== undefined) return link;
    }
    await pause(250);
  }
  throw new Error(`no mail to ${email} in Mailpit`);
}

/**
 * A brand-new account: the terminal asks for a device code, the person opens the page, signs in
 * with the mailed link (which creates the account, its personal workspace and plan on the first
 * time), sees the device and approves it; the terminal's poll returns the tokens.
 */
export async function signUp(label: string): Promise<Person & { email: string }> {
  const email = `${label}-${randomBytes(4).toString('hex')}@dev.test`;
  const keychain = net.memoryKeychain();
  const keys = new net.DeviceKeyStore(keychain);
  const anonymous = net.createHttpClient({
    baseUrl: api,
    userAgent: net.defaultUserAgent('0.0.0'),
    getAccessToken: () => Promise.resolve(undefined),
  });
  const login = await net.startDeviceLogin({
    http: anonymous,
    deviceName: `${label}-laptop`,
    keys,
  });
  const tokens = login.poll();
  const browser = new Browser();
  const entry = await browser.send(`/device?user_code=${login.userCode}`);
  if (entry.res.status !== 303) throw new Error(`device page: ${entry.res.status}`);
  const form = await browser.send('/device/login');
  const sent = await browser.post('/login/email', {
    email,
    return_to: hidden(form.body, 'return_to'),
  });
  if (sent.res.status !== 202) throw new Error(`sign-in mail: ${sent.res.status}`);
  const confirm = await browser.send(await mailedLink(email));
  const verified = await browser.post('/login/email/verify', {
    t: hidden(confirm.body, 't'),
    csrf: hidden(confirm.body, 'csrf'),
  });
  if (verified.res.status !== 303) throw new Error(`sign-in: ${verified.res.status}`);
  const page = await browser.send(`/device?user_code=${login.userCode}`);
  const decided = await browser.post('/device/approve', {
    csrf: hidden(page.body, 'csrf'),
    user_code: login.userCode,
  });
  if (!decided.body.includes('Device allowed')) throw new Error('the device was not allowed');
  const set = await tokens;
  await keys.rebindDeviceId(set.deviceId);
  const me = (await (
    await fetch(`${api}/v1/me`, { headers: { authorization: `Bearer ${set.accessToken}` } })
  ).json()) as { user: { id: string } };
  return { ...makePerson(label, me.user.id, set.deviceId, set.accessToken, keys, keychain), email };
}

/** An access token with the web app's scopes for `who` (invites need `workspaces:write`). */
export function appToken(who: Person): string {
  const out = execFileSync('pnpm', ['-s', 'dev:token', who.userId, who.deviceId], {
    cwd: resolve(here, '../..'),
    encoding: 'utf8',
  });
  return (JSON.parse(out.trim().split('\n').pop() ?? '{}') as { access_token: string })
    .access_token;
}

/** Collects the readable messages a session client receives. */
export function listen(h: any, into: string[], name: string): void {
  h.onAny((e: any) => {
    if (e.kind === 'message.user') into.push(`${name} read: ${String(e.secret?.text)}`);
  });
}

/** Waits until `ok()` or `ms` pass. */
export async function until(ok: () => boolean, ms = 10_000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (ok()) return true;
    await pause(100);
  }
  return ok();
}
