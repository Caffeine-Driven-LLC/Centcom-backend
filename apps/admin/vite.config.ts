/**
 * The admin console's build (B088): a static site in `dist/web/`, for the private network only.
 *
 * - `VITE_ADMIN_API_BASE` (the admin API's origin, such as `https://admin-api.internal:8081`; empty
 *   for the console's own origin) is compiled in as `__ADMIN_API_BASE__`, and its origin goes into
 *   the page's CSP `connect-src`: the console can reach that API and nothing else.
 * - No inline scripts or styles, no data: assets, no module-preload polyfill, no source maps.
 * - A build is always React's production build, whatever NODE_ENV says (tests set it to `test`).
 *
 * Owns: the build settings and the CSP. Must not: let the CSP name any other origin.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin, type UserConfig } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The placeholder index.html carries where the CSP goes. */
export const CSP_PLACEHOLDER = '__ADMIN_CSP__';

/** The admin API base as given: '' or an absolute http(s) URL without query or fragment. */
export function checkApiBase(apiBase: string): string {
  if (apiBase === '') return '';
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error('VITE_ADMIN_API_BASE must be an absolute http(s) URL');
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== ''
  ) {
    throw new Error(
      'VITE_ADMIN_API_BASE must be an http(s) URL without credentials, query or fragment',
    );
  }
  return apiBase.replace(/\/+$/, '');
}

/** The page's CSP for an admin API at `apiBase`. */
export function contentSecurityPolicy(apiBase: string): string {
  const base = checkApiBase(apiBase);
  const api = base === '' ? '' : ` ${new URL(base).origin}`;
  return `default-src 'self'; script-src 'self'; connect-src 'self'${api}; frame-ancestors 'none'`;
}

function cspPlugin(apiBase: string): Plugin {
  return {
    name: 'centcom-admin-csp',
    transformIndexHtml: (html) => html.replace(CSP_PLACEHOLDER, contentSecurityPolicy(apiBase)),
  };
}

/**
 * The Vite configuration for an admin API at `apiBase`, built into `outDir` (default dist/web);
 * `build` for a production build (the dev server leaves React's development build on).
 */
export function adminViteConfig(opts: {
  apiBase: string;
  outDir?: string;
  build?: boolean;
}): UserConfig {
  const apiBase = checkApiBase(opts.apiBase);
  return {
    root: ROOT,
    base: '/',
    envDir: false,
    plugins: [cspPlugin(apiBase)],
    define: {
      __ADMIN_API_BASE__: JSON.stringify(apiBase),
      ...(opts.build === false ? {} : { 'process.env.NODE_ENV': JSON.stringify('production') }),
    },
    build: {
      outDir: opts.outDir ?? fileURLToPath(new URL('dist/web', import.meta.url)),
      emptyOutDir: true,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      sourcemap: false,
    },
    server: { host: '127.0.0.1', strictPort: true },
  };
}

export default defineConfig(({ mode, command }) =>
  adminViteConfig({
    apiBase: loadEnv(mode, ROOT, 'VITE_')['VITE_ADMIN_API_BASE'] ?? '',
    build: command === 'build',
  }),
);
