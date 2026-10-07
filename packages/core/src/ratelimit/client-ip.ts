/**
 * Client addresses for rate limiting (B023): the address at the other end of a request behind a
 * configured number of trusted proxies (Fly's edge, a CDN), and the bucket an address counts in:
 * an IPv4 address itself, or the /64 of an IPv6 address, since one host usually holds a whole /64.
 *
 * Owns: reading `X-Forwarded-For` and `Fly-Client-IP` only as far as the trusted hops reach.
 * Must not: let a header the client wrote choose the address, or throw on a malformed header.
 */
import { isIP } from 'node:net';

/** The address of a request that has none: no socket address and no trusted header. */
export const UNKNOWN_IP = 'unknown';
/** The most trusted proxies (the range of TRUSTED_PROXY_HOPS). */
export const MAX_TRUSTED_HOPS = 10;

/** What `resolveClientIp` reads; a FastifyRequest or a Node IncomingMessage fits. */
export interface ClientIpSource {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/** Longest text taken for an address: an IPv6 address with brackets, a zone and a port fits. */
const MAX_ADDRESS_LENGTH = 100;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_TAIL = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The 8 groups of an IPv6 address that `isIP` accepted (one `::` at most, maybe an IPv4 tail). */
function hextets(ip: string): number[] {
  let text = ip;
  const tail: string[] = [];
  const v4 = IPV4_TAIL.exec(text);
  if (v4 !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.slice(1).map(Number);
    tail.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    text = text.slice(0, v4.index);
    // `1:2:3:4:5:6:1.2.3.4` leaves `1:2:3:4:5:6:`; `::1.2.3.4` leaves `::`, which stays.
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const zeros =
    rest === undefined ? [] : Array<string>(8 - left.length - right.length - tail.length).fill('0');
  return [...left, ...zeros, ...right, ...tail].map((group) => parseInt(group, 16));
}

/**
 * An address in canonical form, or undefined when `raw` is not one: an IPv4 dotted quad, or a
 * lower-case IPv6 address (an IPv4-mapped IPv6 address becomes its IPv4 address). Takes the forms
 * proxies write: a port after an IPv4 address (`1.2.3.4:5678`), brackets around an IPv6 address
 * with or without a port (`[2001:db8::1]:443`), a zone (`fe80::1%eth0`).
 */
export function normalizeIp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let text = raw.trim();
  if (text.length === 0 || text.length > MAX_ADDRESS_LENGTH) return undefined;
  text = BRACKETED.exec(text)?.[1] ?? IPV4_WITH_PORT.exec(text)?.[1] ?? text;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  text = text.toLowerCase();
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6) return undefined;
  const groups = hextets(text);
  // ::ffff:a.b.c.d, or its hex form: an IPv4 client seen through a dual-stack socket.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return text;
}

/** The bucket an address counts in: an IPv4 address itself, an IPv6 address's /64. */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const prefix = hextets(ip)
    .slice(0, 4)
    .map((group) => group.toString(16));
  return `${prefix.join(':')}::/64`;
}

/** A header's value as one string (Node joins most repeated headers with commas already). */
const headerText = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(',') : value;

/**
 * The client's address behind `trustedHops` proxies, or UNKNOWN_IP.
 *
 * - **0 hops:** the socket address; every header is ignored.
 * - **1 or more:** each trusted proxy appends the address it received the request from to
 *   `X-Forwarded-For`, so the client is the `trustedHops`-th entry from the right, or the leftmost
 *   one when there are fewer (fewer proxies than configured). Entries further left are the
 *   client's own say-so and are never read. A malformed entry ends the walk: the last good one
 *   wins. `Fly-Client-IP` (Fly's edge) stands in when `X-Forwarded-For` has no usable entry.
 * - **No address at all:** the socket address, else UNKNOWN_IP.
 */
export function resolveClientIp(req: ClientIpSource, trustedHops: number): string {
  if (!Number.isSafeInteger(trustedHops) || trustedHops < 0 || trustedHops > MAX_TRUSTED_HOPS) {
    throw new RangeError(`trustedHops must be a whole number from 0 to ${MAX_TRUSTED_HOPS}`);
  }
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (trustedHops === 0) return peer ?? UNKNOWN_IP;
  const entries = (headerText(req.headers['x-forwarded-for']) ?? '').split(',');
  let client: string | undefined;
  for (const entry of entries.slice(-trustedHops).reverse()) {
    const ip = normalizeIp(entry);
    if (ip === undefined) break;
    client = ip;
  }
  client ??= normalizeIp(headerText(req.headers['fly-client-ip']));
  return client ?? peer ?? UNKNOWN_IP;
}
