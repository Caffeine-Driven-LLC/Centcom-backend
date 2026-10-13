/**
 * A fake SMTP server for the SMTP provider's tests (B032 follow-up): speaks enough ESMTP to take
 * one message (EHLO, STARTTLS, AUTH PLAIN, MAIL, RCPT, DATA, QUIT), keeps what it received, and
 * can be told to refuse a step with a given reply. TLS uses a throwaway certificate made with
 * `openssl` at test time (nothing secret is committed); `tlsMaterial()` is undefined without it.
 */
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, createServer as createTlsServer } from 'node:tls';

export interface TlsMaterial {
  key: string;
  cert: string;
}

let material: TlsMaterial | undefined | null = null;

/** A self-signed certificate for localhost, or undefined if openssl is not installed. */
export function tlsMaterial(): TlsMaterial | undefined {
  if (material !== null) return material;
  const dir = mkdtempSync(join(tmpdir(), 'smtp-test-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-subj',
        '/CN=localhost',
        '-days',
        '2',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    material = {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    };
  } catch {
    material = undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return material;
}

export interface Received {
  mailFrom: string;
  rcptTo: string[];
  data: string;
  authenticated: boolean;
  encrypted: boolean;
}

export interface FakeSmtpOptions {
  mode: 'plain' | 'starttls' | 'tls';
  /** Advertise STARTTLS (default true in starttls mode). */
  offerStarttls?: boolean;
  /** Required credentials for AUTH PLAIN (`\0user\0password`). */
  auth?: { user: string; password: string };
  /** Replace the reply to a verb (MAIL, RCPT, DATA, AUTH, EHLO, or `.` for end of data). */
  refuse?: Partial<Record<'MAIL' | 'RCPT' | 'DATA' | 'AUTH' | 'END', string>>;
  /** Never answer the greeting (timeout test). */
  silent?: boolean;
}

export interface FakeSmtp {
  port: number;
  received: Received[];
  commands: string[];
  close(): Promise<void>;
}

export async function startFakeSmtp(options: FakeSmtpOptions): Promise<FakeSmtp> {
  const tls = tlsMaterial();
  const received: Received[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  const serve = (raw: Socket): void => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => undefined);
    let socket: Socket = raw;
    let encrypted = options.mode === 'tls';
    let buffer = '';
    let inData = false;
    let current: Received = { mailFrom: '', rcptTo: [], data: '', authenticated: false, encrypted };
    const say = (line: string): void => void socket.write(`${line}\r\n`);
    const attach = (s: Socket): void => {
      s.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let eol = buffer.indexOf('\r\n');
        while (eol >= 0) {
          const line = buffer.slice(0, eol);
          buffer = buffer.slice(eol + 2);
          handle(line);
          eol = buffer.indexOf('\r\n');
        }
      });
    };
    const handle = (line: string): void => {
      if (inData) {
        if (line === '.') {
          inData = false;
          current.encrypted = encrypted;
          commands.push('END');
          if (options.refuse?.END !== undefined) return say(options.refuse.END);
          received.push(current);
          current = {
            mailFrom: '',
            rcptTo: [],
            data: '',
            authenticated: current.authenticated,
            encrypted,
          };
          return say('250 2.0.0 queued');
        }
        current.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
        return;
      }
      const verb = line.split(' ')[0]?.toUpperCase() ?? '';
      commands.push(verb);
      const refused = options.refuse?.[verb as 'MAIL'];
      if (refused !== undefined) return say(refused);
      switch (verb) {
        case 'EHLO': {
          const offer =
            (options.offerStarttls ?? true) && options.mode === 'starttls' && !encrypted;
          say('250-fake.test greets you');
          if (offer) say('250-STARTTLS');
          say('250 AUTH PLAIN');
          return;
        }
        case 'STARTTLS': {
          say('220 go ahead');
          buffer = '';
          raw.removeAllListeners('data');
          const upgraded = new TLSSocket(raw, { isServer: true, key: tls?.key, cert: tls?.cert });
          upgraded.on('error', () => undefined);
          socket = upgraded;
          encrypted = true;
          attach(upgraded);
          return;
        }
        case 'AUTH': {
          const want = options.auth;
          const given = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          if (want !== undefined && given !== `\0${want.user}\0${want.password}`) {
            return say('535 5.7.8 bad credentials');
          }
          current.authenticated = true;
          return say('235 2.7.0 ok');
        }
        case 'MAIL':
          current.mailFrom = /<(.*)>/.exec(line)?.[1] ?? '';
          return say('250 ok');
        case 'RCPT':
          current.rcptTo.push(/<(.*)>/.exec(line)?.[1] ?? '');
          return say('250 ok');
        case 'DATA':
          inData = true;
          return say('354 end with <CRLF>.<CRLF>');
        case 'QUIT':
          say('221 bye');
          socket.end();
          return;
        default:
          say('502 not implemented');
      }
    };
    attach(socket);
    if (options.silent !== true) say('220 fake.test ESMTP');
  };

  let server: Server;
  if (options.mode === 'tls') {
    server = createTlsServer({ key: tls?.key, cert: tls?.cert }, serve);
  } else {
    server = createServer(serve);
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    received,
    commands,
    close: async () => {
      for (const s of sockets) s.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
