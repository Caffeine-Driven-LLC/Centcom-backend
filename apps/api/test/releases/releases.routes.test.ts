/**
 * The release endpoints (B084) on the API's stack:
 *
 * - integration: publish, then `latest`, then yank, then `latest` serves the previous version
 *   (within a refresh; the HTTP max-age is 60 s), with nothing deleted;
 * - 400 at `/platform` / `/arch`, 404 for an unknown channel or a channel without a release;
 * - ETag and 304, `public, max-age=60` / `max-age=300`, no authentication, B023's anonymous limit
 *   (30 a minute per address) with `RateLimit-*` headers;
 * - contract: `manifest.json` is the published text byte for byte and matches the schema; `latest`
 *   is a schema-valid manifest of that platform's artifacts;
 * - abuse: huge query strings and odd channel paths are 4xx without stack traces;
 * - Postgres down: the last set for 60 s, then 503 with `retry_after_s`; corrupt rows skipped.
 */
import { validate } from '@centcom/contracts';
import { describe, expect, it } from 'vitest';
import { RELEASES_STALE_MS } from '../../src/modules/releases/cache.js';
import { get, manifest, releasesApp, T0, until } from './helpers.js';

const LATEST = '/v1/releases/stable/latest?platform=linux&arch=x64';

describe('publish, latest, yank', () => {
  it('serves the newest version, and the previous one after a yank, keeping the yanked row', async () => {
    const t = await releasesApp();
    const v1 = JSON.stringify(manifest(t.key, { version: '1.0.0' }));
    await t.publisher.publishRelease(v1, { kind: 'system', name: 'test' });
    await t.publisher.publishRelease(
      manifest(t.key, { version: '1.1.0', released_at: new Date(T0 + 1000).toISOString() }),
      { kind: 'system', name: 'test' },
    );
    await until(
      async () => (await get(t.app, LATEST)).json<{ version?: string }>().version === '1.1.0',
    );
    const latest = await get(t.app, LATEST);
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      channel: 'stable',
      version: '1.1.0',
      min_supported: '1.0.0',
      min_client_version: '1.0.0',
      artifacts: [
        { platform: 'linux', arch: 'x64', url: 'https://dl.centcom.dev/1.1.0/centcom-linux-x64' },
      ],
    });

    expect(
      await t.publisher.yankRelease('1.1.0', 'stable', 'crash on start', {
        kind: 'system',
        name: 'test',
      }),
    ).toEqual({
      version: '1.1.0',
      channel: 'stable',
      yanked: true,
    });
    await until(
      async () => (await get(t.app, LATEST)).json<{ version?: string }>().version === '1.0.0',
    );
    expect((await get(t.app, '/v1/releases/stable/manifest.json')).body).toBe(v1);
    // Nothing is lost: the yanked release keeps its row and manifest.
    expect(t.repo.rows.find((r) => r.version === '1.1.0')).toMatchObject({
      yankReason: 'crash on start',
    });
    expect(t.repo.rows.find((r) => r.version === '1.1.0')?.yankedAt).not.toBeNull();
    // Yanking again changes nothing; an unknown release is 404.
    expect(
      (await t.publisher.yankRelease('1.1.0', 'stable', 'x', { kind: 'system', name: 'test' }))
        .yanked,
    ).toBe(false);
    await expect(
      t.publisher.yankRelease('9.9.9', 'stable', 'x', { kind: 'system', name: 'test' }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await t.app.close();
  });

  it('reaches every process within a refresh, without announcements too', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(manifest(t.key), { kind: 'system', name: 'test' });
    // A second process that missed the announcement still loads at its 30 s refresh (or on demand).
    await t.cache.refresh();
    expect((await get(t.app, LATEST)).statusCode).toBe(200);
    await t.app.close();
  });
});

describe('requests', () => {
  it('answers 400 at /platform and /arch, and 404 for unknown channels or missing releases', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(
      manifest(t.key, {
        artifacts: manifest(t.key).artifacts.filter((a) => a.platform === 'linux'),
      }),
      { kind: 'system', name: 'test' },
    );
    await t.cache.refresh();
    const cases: [string, number, string[] | null][] = [
      ['/v1/releases/stable/latest', 400, ['/platform', '/arch']],
      ['/v1/releases/stable/latest?arch=x64', 400, ['/platform']],
      ['/v1/releases/stable/latest?platform=linux', 400, ['/arch']],
      ['/v1/releases/stable/latest?platform=solaris&arch=x64', 400, ['/platform']],
      ['/v1/releases/stable/latest?platform=linux&arch=riscv', 400, ['/arch']],
      ['/v1/releases/stable/latest?platform=linux&platform=darwin&arch=x64', 400, ['/platform']],
      ['/v1/releases/canary/latest?platform=linux&arch=x64', 404, null],
      ['/v1/releases/canary/manifest.json', 404, null],
      ['/v1/releases/stable/latest?platform=macos&arch=arm64', 404, null],
      ['/v1/releases/beta/latest?platform=linux&arch=x64', 404, null],
      ['/v1/releases/nightly/manifest.json', 404, null],
    ];
    for (const [url, status, pointers] of cases) {
      const res = await get(t.app, url);
      expect(res.statusCode, url).toBe(status);
      expect(res.headers['content-type'], url).toMatch(/^application\/problem\+json/);
      expect(validate('problem', res.json()).ok, url).toBe(true);
      if (pointers !== null) {
        expect(res.json<{ code: string }>().code).toBe('invalid_request');
        expect(
          res.json<{ errors: { pointer: string }[] }>().errors.map((e) => e.pointer),
          url,
        ).toEqual(pointers);
      }
    }
    // OpenAPI's platform names and the manifest's are both understood.
    expect(
      (await get(t.app, '/v1/releases/stable/latest?platform=linux&arch=arm64')).statusCode,
    ).toBe(200);
    await t.publisher.publishRelease(manifest(t.key, { version: '1.0.1' }), {
      kind: 'system',
      name: 'test',
    });
    await t.cache.refresh();
    for (const platform of ['macos', 'darwin', 'windows', 'win32']) {
      expect(
        (await get(t.app, `/v1/releases/stable/latest?platform=${platform}&arch=x64`)).statusCode,
        platform,
      ).toBe(200);
    }
    await t.app.close();
  });

  it('caches by ETag, with the stated Cache-Control, and needs no credentials', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(manifest(t.key), { kind: 'system', name: 'test' });
    await t.cache.refresh();
    for (const [url, maxAge] of [
      [LATEST, 60],
      ['/v1/releases/stable/manifest.json', 300],
    ] as const) {
      const first = await get(t.app, url);
      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe(`public, max-age=${maxAge}`);
      expect(first.headers['content-type']).toBe('application/json; charset=utf-8');
      const etag = String(first.headers['etag']);
      expect(etag).toMatch(/^"r[A-Za-z0-9_-]{22}"$/);
      const again = await get(t.app, url, { 'if-none-match': etag });
      expect(again.statusCode).toBe(304);
      expect(again.body).toBe('');
      expect(again.headers['etag']).toBe(etag);
      expect((await get(t.app, url, { 'if-none-match': '"r-other"' })).statusCode).toBe(200);
      // A credential is neither needed nor looked at.
      expect((await get(t.app, url, { authorization: 'Bearer nonsense' })).statusCode).toBe(200);
    }
    await t.app.close();
  });

  it('applies the anonymous rate limit, 30 a minute per address, with RateLimit headers', async () => {
    const t = await releasesApp({ rateLimit: true });
    await t.publisher.publishRelease(manifest(t.key), { kind: 'system', name: 'test' });
    await t.cache.refresh();
    for (let i = 1; i <= 30; i += 1) {
      const res = await get(t.app, LATEST);
      expect(res.statusCode).toBe(200);
      expect(res.headers['ratelimit-limit']).toBe('30');
      expect(res.headers['ratelimit-remaining']).toBe(String(30 - i));
    }
    const limited = await get(t.app, LATEST);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code: string }>().code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
    await t.app.close();
  });

  it('turns abusive requests away with 4xx, without stack traces', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(manifest(t.key), { kind: 'system', name: 'test' });
    await t.cache.refresh();
    const urls = [
      `/v1/releases/stable/latest?platform=${'x'.repeat(20_000)}&arch=x64`,
      `/v1/releases/stable/latest?platform=linux&arch=x64&junk=${'y'.repeat(20_000)}`,
      `/v1/releases/${'s'.repeat(5000)}/latest?platform=linux&arch=x64`,
      '/v1/releases/stable%00/latest?platform=linux&arch=x64',
      '/v1/releases/../stable/latest?platform=linux&arch=x64',
      '/v1/releases/__proto__/manifest.json',
      '/v1/releases/stable/latest?platform[]=linux&arch=x64',
    ];
    for (const url of urls) {
      const res = await get(t.app, url);
      expect(res.statusCode, url.slice(0, 60)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url.slice(0, 60)).toBeLessThan(500);
      expect(res.body).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
    }
    // A short unknown parameter is ignored, not an error.
    expect((await get(t.app, `${LATEST}&junk=1`)).statusCode).toBe(200);
    await t.app.close();
  });
});

describe('contract', () => {
  it('serves manifest.json byte for byte as published, and latest as a schema-valid manifest', async () => {
    const t = await releasesApp();
    // Odd spacing and key order: the bytes are kept, whatever they are.
    const published = `{ "version": "1.0.0", "channel": "stable",\n  "released_at": "${new Date(T0).toISOString()}", "min_supported": "1.0.0",\n  "artifacts": ${JSON.stringify(manifest(t.key).artifacts, null, 4)} }\n`;
    await t.publisher.publishRelease(published, { kind: 'system', name: 'test' });
    await t.cache.refresh();
    const full = await get(t.app, '/v1/releases/stable/manifest.json');
    expect(full.body).toBe(published);
    expect(validate('release-manifest', full.json()).ok).toBe(true);
    for (const platform of ['linux', 'darwin', 'win32']) {
      const res = await get(t.app, `/v1/releases/stable/latest?platform=${platform}&arch=arm64`);
      const body = res.json<{ artifacts: { platform: string; arch: string }[] }>();
      expect(validate('release-manifest', body).ok).toBe(true);
      expect(body.artifacts).toEqual([expect.objectContaining({ platform, arch: 'arm64' })]);
      expect(res.headers['etag']).toBeDefined();
    }
    await t.app.close();
  });
});

describe('failures', () => {
  it('serves the last set for 60 s while Postgres is down, then 503 with retry_after_s', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(manifest(t.key), { kind: 'system', name: 'test' });
    await t.cache.refresh();
    const etag = (await get(t.app, LATEST)).headers['etag'];
    t.repo.down = true;
    await t.cache.refresh().catch(() => undefined);
    t.clock.now = T0 + RELEASES_STALE_MS;
    const stale = await get(t.app, LATEST);
    expect(stale.statusCode).toBe(200);
    expect(stale.headers['etag']).toBe(etag);
    t.clock.now = T0 + RELEASES_STALE_MS + 1;
    const down = await get(t.app, LATEST);
    expect(down.statusCode).toBe(503);
    expect(down.json<{ code: string; retry_after_s: number }>()).toMatchObject({
      code: 'service_unavailable',
      retry_after_s: 5,
    });
    t.repo.down = false;
    t.clock.now += 2000;
    expect((await get(t.app, LATEST)).statusCode).toBe(200);
    await t.app.close();
  });

  it('skips a corrupt stored manifest, counts it, and serves the previous version', async () => {
    const t = await releasesApp();
    await t.publisher.publishRelease(manifest(t.key, { version: '1.0.0' }), {
      kind: 'system',
      name: 'test',
    });
    await t.publisher.publishRelease(manifest(t.key, { version: '1.1.0' }), {
      kind: 'system',
      name: 'test',
    });
    const newest = t.repo.rows.find((r) => r.version === '1.1.0');
    if (newest !== undefined) newest.manifest = newest.manifest.slice(0, 40);
    await t.cache.refresh();
    const res = await get(t.app, LATEST);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ version: string }>().version).toBe('1.0.0');
    expect(t.recorded.count('releases_corrupt_total')).toBe(1);
    await t.app.close();
  });
});
