/**
 * The admin listener's network allowlist (B087, ADMIN_ALLOWED_CIDRS): CIDR blocks, IPv4 or IPv6,
 * checked against a connection's remote address before any byte is read. An IPv4 address seen
 * through a dual-stack socket (`::ffff:10.0.0.7`) is checked as IPv4. Forwarded headers are never
 * consulted: the listener sits on the private network, behind no proxy that could set them.
 *
 * Owns: parsing and matching. Must not: allow an address it cannot parse.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** One allowed block. */
export interface Cidr {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** The block in `text` (`10.0.0.0/8`, `fd00::/8`; a bare address is a /32 or /128), or null. */
export function parseCidr(text: string): Cidr | null {
  const [address = '', prefixText, extra] = text.trim().split('/');
  if (extra !== undefined) return null;
  const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
  if (family === null) return null;
  const max = family === 'ipv4' ? 32 : 128;
  if (prefixText === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  return prefix <= max ? { address, prefix, family } : null;
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Whether an address is inside one of `cidrs`. An address that is not an IP is outside. */
export function cidrMatcher(cidrs: readonly Cidr[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  for (const cidr of cidrs) list.addSubnet(cidr.address, cidr.prefix, cidr.family);
  return (address) => {
    if (address === undefined) return false;
    const mapped = MAPPED_V4.exec(address)?.[1];
    if (mapped !== undefined && isIPv4(mapped)) return list.check(mapped, 'ipv4');
    if (isIPv4(address)) return list.check(address, 'ipv4');
    if (isIPv6(address)) return list.check(address, 'ipv6');
    return false;
  };
}
