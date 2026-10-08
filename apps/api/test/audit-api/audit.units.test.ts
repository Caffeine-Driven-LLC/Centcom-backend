/**
 * The audit API's pure parts (B082 test plan "unit"): the filter builder, cursors bound to the
 * workspace and filters, CSV escaping and the formula-injection guard, the mapping to contract
 * `AuditEvent`s, SigV4 against AWS's published S3 examples, and the configuration's bounds.
 */
import { validate } from '@centcom/contracts';
import { AUDIT_ACTIONS, isAppError } from '@centcom/core';
import { describe, expect, it } from 'vitest';
import { AUDIT_API_ACTIONS } from '../../src/modules/audit-api/actions.js';
import { loadAuditApiConfig } from '../../src/modules/audit-api/config.js';
import { csvCell, csvLine, exportWriter } from '../../src/modules/audit-api/csv.js';
import {
  filterNames,
  listFilterHash,
  parseExportBody,
  parseListFilters,
} from '../../src/modules/audit-api/filters.js';
import { presentEvent } from '../../src/modules/audit-api/present.js';
import { retentionFromEntitlements } from '../../src/modules/audit-api/service.js';
import {
  authorizationHeader,
  canonicalQuery,
  EMPTY_SHA256,
  presignQuery,
  type SigningCredentials,
} from '../../src/modules/audit-api/sigv4.js';
import { auditRow, T0 } from './helpers.js';

const WSP = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4W';
const USR = 'usr_01JA3Z8K2M5N7P9Q0R1S2T3V4W';

/** The pointers of the 422 that `fn` throws. */
function pointers(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (isAppError(err)) return (err.errors ?? []).map((e) => e.pointer);
    throw err;
  }
  throw new Error('expected a 422');
}

describe('filters', () => {
  it('reads actor, action and the range, ignoring other parameters', () => {
    expect(
      parseListFilters({
        actor: USR,
        action: 'member.add',
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-02T00:00:00+02:00',
        limit: '5',
        workspace: 'x',
      }),
    ).toEqual({
      actor: USR,
      action: 'member.add',
      range: { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-01T22:00:00Z') },
    });
    expect(parseListFilters({})).toEqual({});
    expect(parseListFilters({ to: '2026-10-02T00:00:00Z' })).toEqual({
      range: { to: new Date('2026-10-02T00:00:00Z') },
    });
    for (const prefix of ['usr', 'key', 'dev']) {
      const actor = `${prefix}_01JA3Z8K2M5N7P9Q0R1S2T3V4W`;
      expect(parseListFilters({ actor }).actor).toBe(actor);
    }
    // The same instant is one range: `from` equal to `to` is allowed (and matches nothing).
    expect(parseListFilters({ from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toEqual({
      range: { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') },
    });
  });

  it('reports every bad filter, `from` after `to` at /from', () => {
    expect(
      pointers(() =>
        parseListFilters({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }),
      ),
    ).toEqual(['/from']);
    expect(
      pointers(() =>
        parseListFilters({ actor: WSP, action: '', from: '2026-13-01', to: ['a', 'b'] }),
      ),
    ).toEqual(['/actor', '/action', '/from', '/to']);
    expect(pointers(() => parseListFilters({ action: 'a\u0000b' }))).toEqual(['/action']);
  });

  it('binds cursors to the workspace and the filters, not to their spelling or order', () => {
    const a = parseListFilters({ actor: USR, from: '2026-10-01T00:00:00Z' });
    const b = parseListFilters({ from: '2026-10-01T00:00:00+00:00', actor: USR });
    expect(listFilterHash(WSP, a)).toBe(listFilterHash(WSP, b));
    expect(listFilterHash(WSP, a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const other = 'wsp_01JA3Z8K2M5N7P9Q0R1S2T3V4X';
    expect(listFilterHash(other, a)).not.toBe(listFilterHash(WSP, a));
    expect(listFilterHash(WSP, { ...a, action: 'member.add' })).not.toBe(listFilterHash(WSP, a));
    expect(listFilterHash(WSP, {})).not.toBe(listFilterHash(WSP, a));
    expect(filterNames(parseListFilters({ to: '2026-10-01T00:00:00Z', actor: USR }))).toEqual([
      'actor',
      'to',
    ]);
  });

  it('reads an export body: format, filters and gzip', () => {
    expect(parseExportBody({ format: 'json', action: 'member.add', gzip: true })).toEqual({
      format: 'json',
      gzip: true,
      filters: { action: 'member.add' },
    });
    expect(parseExportBody({ format: 'csv' })).toEqual({ format: 'csv', gzip: false, filters: {} });
    expect(pointers(() => parseExportBody(null))).toContain('');
    expect(pointers(() => parseExportBody({ format: 'csv', actor: 'x', gzip: 1 }))).toEqual(
      expect.arrayContaining(['/actor', '/gzip']) as unknown,
    );
  });
});

describe('CSV', () => {
  it('quotes what must be quoted (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('')).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
  });

  it("neutralises formula cells with a leading '", () => {
    for (const start of ['=', '+', '-', '@', '\t']) {
      expect(csvCell(`${start}1+1`), JSON.stringify(start)).toBe(`'${start}1+1`);
    }
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
    expect(csvCell('=SUM(A1,A2)')).toBe(`"'=SUM(A1,A2)"`);
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a=1')).toBe('a=1');
    expect(csvCell('2026-10-08T12:00:00.000Z')).toBe('2026-10-08T12:00:00.000Z');
  });

  it('writes one line per event and frames JSON as an array', () => {
    const event = presentEvent(auditRow(WSP, { at: T0, meta: { role: 'admin', via: 'invite' } }));
    const line = csvLine(event);
    expect(line.endsWith('\r\n')).toBe(true);
    expect(line).toContain(`,${WSP},user,`);
    expect(line).toContain('"{""role"":""admin"",""via"":""invite""}"');
    const json = exportWriter('json');
    const text = json.open() + json.event(event, 0) + json.event(event, 1) + json.close();
    expect(JSON.parse(text)).toEqual([event, event]);
    const empty = json.open() + json.close();
    expect(JSON.parse(empty)).toEqual([]);
  });
});

describe('AuditEvent mapping', () => {
  it('maps actors, outcomes, targets and meta to the contract, and shows nothing else', () => {
    const base = auditRow(WSP, { at: T0 });
    const user = presentEvent(base);
    expect(user).toEqual({
      id: base.id,
      workspace: WSP,
      at: new Date(T0).toISOString(),
      actor: { type: 'user', id: base.actor_id },
      action: 'member.add',
      target: { type: 'membership', id: base.target_id },
      result: 'allowed',
      metadata: { role: 'member', via: 'invite' },
    });
    const device = presentEvent({
      ...base,
      actor_type: 'device',
      actor_id: 'dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W',
    });
    expect(device.actor).toEqual({ type: 'user', id: 'dev_01JA3Z8K2M5N7P9Q0R1S2T3V4W' });
    expect(presentEvent({ ...base, actor_type: 'system', actor_id: 'retention' }).actor).toEqual({
      type: 'system',
      id: 'retention',
    });
    expect(presentEvent({ ...base, outcome: 'denied' }).result).toBe('denied');
    expect('result' in presentEvent({ ...base, outcome: 'failed' })).toBe(false);
    expect('target' in presentEvent({ ...base, target_type: null, target_id: null })).toBe(false);
    // Meta outside the action's allowlist is dropped; secret-like strings are redacted.
    expect(
      presentEvent({
        ...base,
        meta: { role: 'admin', ip: '10.0.0.1', user_agent: 'curl', via: 'someone@example.test' },
      }).metadata,
    ).toEqual({ role: 'admin', via: '[redacted]' });
    expect(presentEvent({ ...base, action: 'unknown.thing' }).metadata).toEqual({});
    expect(presentEvent({ ...base, action: 'constructor' }).metadata).toEqual({});
    expect(presentEvent({ ...base, meta: 'not an object' }).metadata).toEqual({});
    for (const event of [user, device]) expect(validate('api/AuditEvent', event).ok).toBe(true);
  });

  it("extends B036's catalogue with audit.export only", () => {
    expect(Object.keys(AUDIT_API_ACTIONS)).toEqual([...Object.keys(AUDIT_ACTIONS), 'audit.export']);
    expect(AUDIT_API_ACTIONS['audit.export'].meta).toEqual(['format', 'gzip', 'filters']);
    expect(Object.hasOwn(AUDIT_ACTIONS, 'audit.export')).toBe(false);
  });
});

describe('SigV4 (AWS S3 documentation examples)', () => {
  // AWS's published example credentials, assembled at run time.
  const credentials: SigningCredentials = {
    accessKeyId: ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join(''),
    secretAccessKey: ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/'),
    region: 'us-east-1',
    service: 's3',
  };
  const host = 'examplebucket.s3.amazonaws.com';
  const now = new Date('2013-05-24T00:00:00Z');
  const signatureOf = (header: string): string =>
    /Signature=([0-9a-f]{64})$/.exec(header)?.[1] ?? '';

  it('signs GET Object with a Range header', () => {
    const header = authorizationHeader(
      {
        method: 'GET',
        host,
        segments: ['test.txt'],
        headers: {
          range: 'bytes=0-9',
          'x-amz-content-sha256': EMPTY_SHA256,
          'x-amz-date': '20130524T000000Z',
        },
      },
      credentials,
      now,
      EMPTY_SHA256,
    );
    expect(header).toContain(
      `Credential=${credentials.accessKeyId}/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,`,
    );
    expect(signatureOf(header)).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('signs PUT Object, encoding the key', () => {
    const payload = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
    const header = authorizationHeader(
      {
        method: 'PUT',
        host,
        segments: ['test$file.text'],
        headers: {
          date: 'Fri, 24 May 2013 00:00:00 GMT',
          'x-amz-date': '20130524T000000Z',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
          'x-amz-content-sha256': payload,
        },
      },
      credentials,
      now,
      payload,
    );
    expect(signatureOf(header)).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('signs GET Bucket with a query', () => {
    const header = authorizationHeader(
      {
        method: 'GET',
        host,
        segments: [],
        query: { 'max-keys': '2', prefix: 'J' },
        headers: { 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': '20130524T000000Z' },
      },
      credentials,
      now,
      EMPTY_SHA256,
    );
    expect(signatureOf(header)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('pre-signs a GET for a fixed lifetime, host the only signed header', () => {
    const query = presignQuery(
      { method: 'GET', host, segments: ['test.txt'] },
      credentials,
      now,
      86_400,
    );
    expect(query).toBe(
      `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${credentials.accessKeyId}%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404`,
    );
    expect(canonicalQuery({ b: '2', a: 'x y', 'a!': "'" })).toBe('a=x%20y&a%21=%27&b=2');
  });
});

describe('retention', () => {
  it("reads the plan's audit_log_days from the cached entitlements", async () => {
    const asked: string[] = [];
    const days = retentionFromEntitlements({
      get: (workspaceId) => {
        asked.push(workspaceId);
        return Promise.resolve({ limits: { audit_log_days: 90 } } as never);
      },
    });
    expect(await days(WSP)).toBe(90);
    expect(asked).toEqual([WSP]);
  });
});

describe('configuration', () => {
  const env = {
    OBJECT_STORE_ENDPOINT: 'http://127.0.0.1:9000/',
    OBJECT_STORE_BUCKET: 'exports',
    OBJECT_STORE_ACCESS_KEY_ID: 'centcom',
    OBJECT_STORE_SECRET_ACCESS_KEY: 'dev-only-value',
  };

  it('defaults to 1 000 000 rows, 900 s URLs and 24 h files', () => {
    const config = loadAuditApiConfig(env);
    expect(config).toMatchObject({ maxRows: 1_000_000, urlTtlS: 900, retainMs: 24 * 3_600_000 });
    expect(config.objectStore).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'exports',
    });
    expect(JSON.stringify(config)).not.toContain('dev-only-value');
    expect(config.objectStore.secretAccessKey.reveal()).toBe('dev-only-value');
  });

  it('refuses URLs over 900 s, a cap over 1 000 000 and a missing store', () => {
    expect(() => loadAuditApiConfig({ ...env, AUDIT_EXPORT_URL_TTL_S: '901' })).toThrow(
      /AUDIT_EXPORT_URL_TTL_S/,
    );
    expect(() => loadAuditApiConfig({ ...env, AUDIT_EXPORT_MAX_ROWS: '1000001' })).toThrow(
      /AUDIT_EXPORT_MAX_ROWS/,
    );
    expect(() => loadAuditApiConfig({ ...env, OBJECT_STORE_BUCKET: 'No_Such' })).toThrow(
      /OBJECT_STORE_BUCKET/,
    );
    expect(() => loadAuditApiConfig({})).toThrow(/OBJECT_STORE_ENDPOINT/);
  });
});
