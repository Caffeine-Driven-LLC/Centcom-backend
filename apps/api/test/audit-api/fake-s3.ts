/**
 * A small S3-compatible server for the object store tests (B082): path-style PUT, GET and DELETE of
 * objects in one bucket, every request checked as S3 does: SigV4 header auth over the body's
 * SHA-256, or a pre-signed URL that must be unexpired, for the method it was signed for. Its clock
 * is the test's, so URL expiry needs no waiting. The signer is checked separately against AWS's
 * published examples (audit.units.test.ts); MinIO checks the client for real (audit.minio.test.ts).
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authorizationHeader, presignQuery, type SigningCredentials } from '@centcom/storage';

/** A running fake. */
export interface FakeS3 {
  endpoint: string;
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Method, path and status of every request. */
  log: { method: string; path: string; status: number }[];
  /** Milliseconds; the server's clock. */
  clock: { now: number };
  close(): Promise<void>;
}

const parseAmzDate = (value: string): Date =>
  new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Starts the fake on 127.0.0.1 for `bucket`, accepting `credentials`. */
export async function startFakeS3(
  credentials: Omit<SigningCredentials, 'service'>,
  bucket: string,
  now = Date.now(),
): Promise<FakeS3> {
  const signing: SigningCredentials = { ...credentials, service: 's3' };
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const log: FakeS3['log'] = [];
  const clock = { now };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const host = req.headers.host ?? '';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const segments = url.pathname.slice(1).split('/').map(decodeURIComponent);
    if (segments[0] !== bucket) return 404;
    const key = segments.slice(1).join('/');
    const method = req.method ?? 'GET';
    const body = await bodyOf(req);

    const signature = url.searchParams.get('X-Amz-Signature');
    if (signature !== null) {
      const date = url.searchParams.get('X-Amz-Date') ?? '';
      const expires = Number(url.searchParams.get('X-Amz-Expires'));
      const query: Record<string, string> = {};
      for (const [name, value] of url.searchParams) {
        if (!name.startsWith('X-Amz-')) query[name] = value;
      }
      const expected = presignQuery(
        { method, host, segments, query },
        signing,
        parseAmzDate(date),
        expires,
      );
      if (!expected.endsWith(`X-Amz-Signature=${signature}`)) return 403;
      if (clock.now > parseAmzDate(date).getTime() + expires * 1000) return 403;
      if (method !== 'GET') return 403;
      const object = objects.get(key);
      if (object === undefined) return 404;
      const disposition = url.searchParams.get('response-content-disposition');
      if (disposition !== null) res.setHeader('content-disposition', disposition);
      res.setHeader('content-type', object.contentType);
      res.statusCode = 200;
      res.end(object.body);
      return 200;
    }

    const authorization = req.headers.authorization ?? '';
    const signed = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') ?? [];
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    const date = String(req.headers['x-amz-date'] ?? '');
    const headers: Record<string, string> = {};
    for (const name of signed) {
      if (name !== 'host') headers[name] = String(req.headers[name] ?? '');
    }
    const expected = authorizationHeader(
      { method, host, segments, headers },
      signing,
      parseAmzDate(date),
      payloadHash,
    );
    if (expected !== authorization) return 403;
    if (!signed.includes('x-amz-content-sha256') || !signed.includes('x-amz-date')) return 403;
    if (createHash('sha256').update(body).digest('hex') !== payloadHash) return 400;
    if (method === 'PUT') {
      objects.set(key, { body, contentType: String(req.headers['content-type'] ?? '') });
      return 200;
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return 204;
    }
    return 405;
  }

  const server = createServer((req, res) => {
    handle(req, res).then(
      (status) => {
        log.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0] ?? '', status });
        if (!res.headersSent) {
          res.statusCode = status;
          res.end();
        }
      },
      () => {
        res.statusCode = 500;
        res.end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    log,
    clock,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
