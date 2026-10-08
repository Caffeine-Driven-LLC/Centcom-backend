/**
 * `pnpm release:publish <manifest.json> --channel stable|beta|nightly [--dry-run]
 * [--allow-downgrade]` (B084): publishes a signed release manifest. The logic, output and exit
 * codes are `runPublishCli` (apps/api/src/modules/releases/cli.ts); configuration comes from the
 * environment through the config loader (DATABASE_URL, REDIS_URL, RELEASE_PUBKEYS, ...).
 */
import { runPublishCli } from '../src/modules/releases/cli.js';

process.exitCode = await runPublishCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
