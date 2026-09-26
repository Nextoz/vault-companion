import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const SW_ENTRY = fileURLToPath(new URL('./src/sw/sw.ts', import.meta.url));

/**
 * Builds src/sw/sw.ts to /sw.js (stable name, classic script) and injects the precache manifest: index.html
 * plus every content-hashed file under /assets/. Nothing else is ever cached (brief F).
 */
function serviceWorker(): Plugin {
  return {
    name: 'vc-service-worker',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'chunk', id: SW_ENTRY, fileName: 'sw.js' });
    },
    generateBundle(_options, bundle) {
      const sw = bundle['sw.js'];
      if (!sw || sw.type !== 'chunk') return this.error('sw.js was not emitted');
      if (sw.imports.length > 0 || /^\s*(import|export)\s/m.test(sw.code)) {
        return this.error('sw.js must be a self-contained classic script');
      }
      const precache = ['/', ...Object.keys(bundle).filter((f) => f.startsWith('assets/')).sort().map((f) => `/${f}`)];
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 16);
      const placeholder = /(["'`])__VC_PRECACHE__\1/;
      if (!placeholder.test(sw.code)) return this.error('precache placeholder missing from sw.js');
      sw.code = sw.code.replace(placeholder, () => JSON.stringify(JSON.stringify({ version, precache })));
    },
  };
}

/** Production-only CSP: dev needs inline scripts for React refresh. The Worker should also send it as a header. */
function contentSecurityPolicy(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'vc-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' },
    ],
  };
}

let commit = 'dev';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'dev';
} catch { /* Source archives and tests may have no Git executable or repository. */ }

export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify({ commit, builtAt: new Date().toISOString() }) },
  plugins: [react(), serviceWorker(), contentSecurityPolicy()],
  build: { target: 'es2022', sourcemap: false },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
