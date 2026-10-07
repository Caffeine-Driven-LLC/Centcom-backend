/**
 * A minimal Postgres wire-protocol server for client tests without a database: it accepts the
 * startup message without authentication, answers every simple query with one row `{ one: 1 }`,
 * and can end sessions the way `pg_terminate_backend` does (a FATAL 57P01, then the socket closes).
 * It speaks just enough of protocol 3.0 for `pg`: nothing else (no SSL, no extended protocol).
 */
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';

const int32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const int16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const cstring = (s: string): Buffer => Buffer.from(`${s}\0`, 'utf8');
/** A backend message: type byte, int32 length (counting itself), body. */
const message = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
};

const AUTH_OK = message('R', int32(0));
const READY = message('Z', Buffer.from('I'));
/** One int4 column named "one". */
const ROW_DESCRIPTION = message(
  'T',
  int16(1),
  cstring('one'),
  int32(0),
  int16(0),
  int32(23),
  int16(4),
  int32(-1),
  int16(0),
);
const DATA_ROW = message('D', int16(1), int32(1), Buffer.from('1'));
const COMPLETE = message('C', cstring('SELECT 1'));
const TERMINATED = message(
  'E',
  Buffer.from('S'),
  cstring('FATAL'),
  Buffer.from('V'),
  cstring('FATAL'),
  Buffer.from('C'),
  cstring('57P01'),
  Buffer.from('M'),
  cstring('terminating connection due to administrator command'),
  Buffer.from([0]),
);

/** Handles one client connection; returns nothing, writes replies as messages arrive. */
function serve(socket: Socket, sessions: Set<Socket>): void {
  let buffer = Buffer.alloc(0);
  let started = false;
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        started = true;
        sessions.add(socket);
        socket.write(Buffer.concat([AUTH_OK, message('K', int32(4242), int32(1)), READY]));
        continue;
      }
      if (buffer.length < 5) return;
      const type = String.fromCharCode(buffer[0] ?? 0);
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      buffer = buffer.subarray(length + 1);
      if (type === 'X') {
        socket.end();
        return;
      }
      if (type === 'Q') socket.write(Buffer.concat([ROW_DESCRIPTION, DATA_ROW, COMPLETE, READY]));
    }
  });
  socket.on('error', () => undefined);
  socket.on('close', () => sessions.delete(socket));
}

/** Starts the stub on a free localhost port. */
export async function wireServer(): Promise<{
  url: string;
  /** Sessions that completed the startup. */
  sessions: () => number;
  /** Ends every session with FATAL 57P01, as pg_terminate_backend would. */
  terminateAll: () => void;
  close: () => Promise<void>;
}> {
  const sessions = new Set<Socket>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(socket, sessions);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    url: `postgres://centcom:unused@127.0.0.1:${port}/centcom`,
    sessions: () => sessions.size,
    terminateAll: () => {
      for (const socket of sessions) socket.end(TERMINATED);
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
