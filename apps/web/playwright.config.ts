import { defineConfig, devices } from '@playwright/test';

// WebKit on an iPhone 15 viewport against the production build (vite preview), API mocked per test.
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: 'list',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  use: {
    baseURL: 'http://localhost:4173',
    // Deterministic routing: page.route must see every /api request (the SW never handles /api anyway).
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'iphone-15-webkit', use: { ...devices['iPhone 15'], browserName: 'webkit' } }],
  webServer: {
    // Built by the `e2e` script first: one long-lived process that Playwright can stop (a shell chain left
    // `vite preview` orphaned and hung CI after the tests passed).
    command: 'vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
