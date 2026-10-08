/**
 * Where a webhook may go (B081, CT-WEBHOOKS "HTTPS only, no redirects"; SSRF defence):
 *
 * - **On create and update** (`urlProblem`): an `https` URL of at most 2048 characters, without
 *   credentials; its host must be a public name or a public IP literal, and every address it
 *   resolves to must be public. Private, loopback, link-local, CGNAT, metadata (169.254.169.254),
 *   unique-local (fc00::/7) and IPv4-mapped forms of them are refused.
 * - **On every attempt** (`resolveDestination`): the host is resolved again and every address
 *   checked; the request then connects to the first checked address with the original host name
 *   for Host and TLS SNI (http.ts), so a DNS answer that changes between check and connect
 *   (rebinding) cannot redirect it.
 * - **In test mode** (`allowLoopback`), loopback addresses and `http://` to them are allowed, nothing
 *   else.
 *
 * Owns: the address rules. Must not: let a request reach an internal address.
 */
import { isIP } from 'node:net';
import {
  dnsResolver,
  isInternalAddress,
  type HostResolver,
} from '../notifications/push/providers.js';

export { dnsResolver, type HostResolver };

/** Longest endpoint URL. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/** The details of URL refusals. */
export const DESTINATION_DETAILS = Object.freeze({
  scheme: 'must be an https URL',
  length: `must be at most ${MAX_WEBHOOK_URL_LENGTH} characters`,
  credentials: 'must not contain credentials',
  host: 'must resolve only to public addresses',
} as const);

/** An attempt refused because its destination is not public. */
export class BlockedDestinationError extends Error {
  override name = 'BlockedDestinationError';
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

const isLoopback = (address: string): boolean =>
  address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));

/** True when an attempt may connect to `address`. */
export function isAllowedAddress(address: string, allowLoopback: boolean): boolean {
  if (allowLoopback && isLoopback(address)) return true;
  return isIP(address) !== 0 && !isInternalAddress(address);
}

/** The host of `url` without IPv6 brackets. */
const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

/** Why `url` is refused before resolving it, or null. */
export function urlShapeProblem(raw: string, allowLoopback: boolean): string | null {
  if (raw.length > MAX_WEBHOOK_URL_LENGTH) return DESTINATION_DETAILS.length;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DESTINATION_DETAILS.scheme;
  }
  const host = hostOf(url);
  const loopbackHttp = allowLoopback && url.protocol === 'http:' && LOOPBACK_NAMES.has(host);
  if (url.protocol !== 'https:' && !loopbackHttp) return DESTINATION_DETAILS.scheme;
  if (url.username !== '' || url.password !== '') return DESTINATION_DETAILS.credentials;
  if (isIP(host) !== 0 && !isAllowedAddress(host, allowLoopback)) return DESTINATION_DETAILS.host;
  return null;
}

/** Why `url` is refused as an endpoint (its shape, then every resolved address), or null. */
export async function urlProblem(
  raw: string,
  resolve: HostResolver,
  allowLoopback: boolean,
): Promise<string | null> {
  const shape = urlShapeProblem(raw, allowLoopback);
  if (shape !== null) return shape;
  try {
    await resolveDestination(raw, resolve, allowLoopback);
    return null;
  } catch {
    return DESTINATION_DETAILS.host;
  }
}

/** The checked address an attempt connects to. */
export interface Destination {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** Resolves and checks `raw` for one attempt; a BlockedDestinationError when it is not public. */
export async function resolveDestination(
  raw: string,
  resolve: HostResolver,
  allowLoopback: boolean,
): Promise<Destination> {
  if (urlShapeProblem(raw, allowLoopback) !== null) {
    throw new BlockedDestinationError('the URL is not allowed');
  }
  const url = new URL(raw);
  const host = hostOf(url);
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else if (host === 'localhost' && allowLoopback) addresses = ['127.0.0.1'];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new BlockedDestinationError('the host does not resolve');
    }
  }
  if (addresses.length === 0 || !addresses.every((a) => isAllowedAddress(a, allowLoopback))) {
    throw new BlockedDestinationError('the host resolves to an address that is not public');
  }
  const address = addresses[0] ?? '';
  return { url, address, family: isIP(address) === 6 ? 6 : 4 };
}
