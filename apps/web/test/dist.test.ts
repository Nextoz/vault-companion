import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'vc-web-dist-'));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('production web build', () => {
  it('ships _headers so Workers static assets send the security headers', async () => {
    await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    expect(readFileSync(join(outDir, '_headers'), 'utf8')).toBe(readFileSync(join(root, 'public/_headers'), 'utf8'));
  }, 60_000);
});
