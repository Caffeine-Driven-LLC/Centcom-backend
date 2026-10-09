/**
 * The relay's architecture guard (B050, CT-CRYPTO: the relay never decrypts): scans every
 * TypeScript file under a directory (default `apps/relay/src`) and reports any import of a
 * decrypting library, any use of a decrypting primitive, and any key-material environment name.
 * Run as a script it exits 1 when it finds anything, so CI can require it:
 *
 *   pnpm --filter @centcom/relay test:privacy
 *   tsx apps/relay/scripts/privacy-guard.ts [dir]
 *
 * It lives outside `src` on purpose: the names it looks for would otherwise flag the guard itself.
 *
 * Owns: the forbidden lists and the scan. Must not: miss a dynamic import or a `require`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Libraries that can open sealed boxes or decrypt AEAD ciphertext. */
export const FORBIDDEN_MODULES: readonly RegExp[] = [
  /^sodium-native$/,
  /^libsodium-wrappers(-sumo)?$/,
  /^libsodium(\.js)?$/,
  /^tweetnacl(\/.*)?$/,
  /^@noble\/ciphers(\/.*)?$/,
  /^@stablelib\/(xchacha20poly1305|chacha20poly1305|nacl)$/,
];

/** Decrypting primitives, by the name they are called or accessed with. */
export const FORBIDDEN_NAMES: readonly RegExp[] = [
  /^crypto_aead_\w*_decrypt\w*$/,
  /^crypto_box_seal_open$/,
  /^crypto_box_open\w*$/,
  /^crypto_secretbox_open\w*$/,
  /^createDecipheriv$/,
];

/** Environment names that would hold key material (a session key, a device private key, ...). */
export const KEY_MATERIAL_ENV =
  /^[A-Z0-9_]*(SESSION_KEY|DEVICE_(PRIVATE_)?KEY|EPOCH_KEY|INVITE_(KEY|FRAGMENT|SECRET)|KEY_MATERIAL|SEALED?_KEY)[A-Z0-9_]*$/;

/** One finding. */
export interface Finding {
  file: string;
  line: number;
  what: string;
}

/** Every `.ts` file under `dir`, skipping tests and declarations. */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.test.ts'))
      out.push(path);
  }
  return out;
}

/** The findings in `source` (the text of `file`). */
export function scanSource(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Finding[] = [];
  const at = (node: ts.Node, what: string): void => {
    found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, what });
  };
  const moduleName = (spec: ts.Node | undefined): string | null =>
    spec !== undefined && ts.isStringLiteralLike(spec) ? spec.text : null;
  const checkModule = (node: ts.Node, spec: string | null): void => {
    if (spec !== null && FORBIDDEN_MODULES.some((re) => re.test(spec))) at(node, `imports ${spec}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkModule(node, moduleName(node.moduleSpecifier));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require')
      ) {
        checkModule(node, moduleName(node.arguments[0]));
      }
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      if (FORBIDDEN_NAMES.some((re) => re.test(node.text))) at(node, `uses ${node.text}`);
      // A config key or `process.env.X` written as a name.
      if (KEY_MATERIAL_ENV.test(node.text)) at(node, `names key material ${node.text}`);
    }
    if (ts.isStringLiteralLike(node) && KEY_MATERIAL_ENV.test(node.text)) {
      at(node, `names key material ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The findings under `dir`. */
export function scanTree(dir: string): Finding[] {
  return files(dir).flatMap((file) =>
    scanSource(relative(process.cwd(), file), readFileSync(file, 'utf8')),
  );
}

/** Run as a script: report and exit 1 on any finding. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? fileURLToPath(new URL('../src', import.meta.url));
  const findings = scanTree(dir);
  for (const f of findings) process.stderr.write(`${f.file}:${f.line}: ${f.what}\n`);
  process.stdout.write(
    findings.length === 0
      ? `privacy guard: no decrypting code under ${relative(process.cwd(), dir) || '.'}\n`
      : `privacy guard: ${findings.length} finding(s)\n`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}
