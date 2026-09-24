import tseslint from 'typescript-eslint';

const forbidInPureCore = {
  patterns: [
    { group: ['react', 'react-*', 'react/*'], message: 'Core packages must not depend on React.' },
    { group: ['hono', 'hono/*', '@hono/*'], message: 'Core packages must not depend on HTTP frameworks.' },
    { group: ['@cloudflare/*', 'cloudflare:*'], message: 'Core packages must not depend on Cloudflare.' },
    { group: ['@vault-companion/github', '@octokit/*'], message: 'Core packages must not depend on GitHub.' },
    { group: ['node:*'], message: 'Core packages must run on Workers and in browsers: no Node built-ins.' },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'docs/**', 'tools/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['packages/domain/src/**', 'packages/vault-markdown/src/**', 'packages/contracts/src/**'],
    rules: { 'no-restricted-imports': ['error', forbidInPureCore] },
  },
  {
    files: ['packages/vault-markdown/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbidInPureCore.patterns,
            { group: ['@vault-companion/domain'], message: 'vault-markdown is below domain.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@vault-companion/github', '@vault-companion/domain', '@vault-companion/vault-markdown'],
              message: 'The web app talks to /api via contracts only.' },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**', 'packages/test-vault/**'],
    rules: { 'no-restricted-imports': 'off', 'no-console': 'off' },
  },
);
