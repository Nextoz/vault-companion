import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // GitHub's windows-latest runners are slow on a cold start (6.6 s for an in-memory test, 10.7 s for real-Git e2e);
    // the 5 s default made CI flaky without catching anything.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
