// @ts-check
/**
 * `pnpm security:sbom` (B097): one CycloneDX JSON SBOM per service, from the lockfile
 * (production dependencies only), written to `sbom/<service>.cdx.json` (git-ignored). CI attaches
 * the folder to the run. An SBOM of a built image (trivy's `--format cyclonedx`) covers the base
 * image layers as well; this one is the application's dependency list.
 *
 * Usage: node infra/security/sbom.mjs [--out <dir>]
 * Exit 0 when all three were written and are valid CycloneDX, 1 otherwise.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Writes a line to stdout / stderr (the repo's lint forbids `console` outside tools/). */
const out = (/** @type {string} */ text) => process.stdout.write(`${text}\n`);
const writeErr = (/** @type {string} */ text) => process.stderr.write(`${text}\n`);

export const SERVICES = ['api', 'relay', 'worker'];

/**
 * Writes the SBOMs and returns their paths.
 * @param {{ root: string, out: string }} o
 * @returns {string[]}
 */
export function writeSboms(o) {
  mkdirSync(o.out, { recursive: true });
  return SERVICES.map((service) => {
    const file = join(o.out, `${service}.cdx.json`);
    execFileSync(
      'pnpm',
      [
        '--filter',
        `@centcom/${service}`,
        'sbom',
        '--sbom-format',
        'cyclonedx',
        '--sbom-type',
        'application',
        '--prod',
        '--lockfile-only',
        '--out',
        file,
      ],
      { cwd: o.root, stdio: 'ignore', timeout: 120_000 },
    );
    const bom = /** @type {{ bomFormat?: string, components?: unknown[] }} */ (
      JSON.parse(readFileSync(file, 'utf8'))
    );
    if (
      bom.bomFormat !== 'CycloneDX' ||
      !Array.isArray(bom.components) ||
      bom.components.length === 0
    ) {
      throw new Error(`${file} is not a CycloneDX SBOM with components`);
    }
    return file;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const i = process.argv.indexOf('--out');
  try {
    for (const file of writeSboms({
      root,
      out: resolve(i === -1 ? join(root, 'sbom') : (process.argv[i + 1] ?? 'sbom')),
    })) {
      out(file);
    }
  } catch (err) {
    writeErr(`security:sbom: ${err instanceof Error ? err.message : 'failed'}`);
    process.exit(1);
  }
}
