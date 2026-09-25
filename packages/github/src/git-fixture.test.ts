import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('isolates fixture Git commands from inherited global and system config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vc-git-config-'));
  try {
    const globalConfig = join(root, 'global.gitconfig');
    const systemConfig = join(root, 'system.gitconfig');
    writeFileSync(globalConfig, '[push]\n\tnegotiate = true\n');
    writeFileSync(systemConfig, '[alias]\n\tfixture-system = status\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '0');
    // The fixture captures its environment on import; poison it before loading.
    vi.resetModules();
    const { git } = await import('./git-fixture.ts');

    expect(git(root, 'config', '--default', '', '--get', 'push.negotiate')).toBe('');
    expect(git(root, 'config', '--default', '', '--get', 'alias.fixture-system')).toBe('');
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  }
});
