/**
 * Build info (B037, CT-VER "Contract files"): the relay's version (its package.json) and the
 * `contract_version` it was built against (contracts/index.json, through @centcom/contracts).
 * Logged at startup.
 *
 * Owns: reading them.
 */
import { createRequire } from 'node:module';
import { CONTRACT_VERSION } from '@centcom/contracts';

/** What a running relay was built from. */
export interface BuildInfo {
  version: string;
  contract_version: string;
}

/** This build's info. */
export function buildInfo(): BuildInfo {
  // `../package.json` is apps/relay/package.json from src/ and from dist/ alike.
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
  return { version: pkg.version, contract_version: CONTRACT_VERSION };
}
