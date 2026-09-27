import { defineConfig, devices } from '@playwright/test';

const SW_SPEC = /offline-shell\.spec\.ts$/;
const REAL_SPEC = /real-stack\.spec\.ts$/;
// Optional: a preinstalled Chromium when Playwright's own download is unavailable (e.g. cloud sandboxes).
const chromiumPath = process.env['PW_CHROMIUM_EXECUTABLE'];

// Against the production build (vite preview), API mocked per test.
// - WebKit on an iPhone 15 viewport: everything except the service worker, which is blocked there so
//   page.route sees every /api request (the SW never handles /api anyway).
// - Chromium: the service-worker offline shell only. Playwright can route service-worker traffic and emulate
//   offline for it in Chromium only, so those tests allow service workers and run there (docs/briefs/P2B-report.md).
// - Chromium real stack (review O3): no mock. Each test serves the build and the real Worker app on one origin of its
//   own (e2e/real-stack.ts), so it ignores `baseURL` and the preview server. Offline emulation needs Chromium.
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: 'list',
  fullyParallel: true,
  // Keep parallel coverage without exhausting RAM on the development machine; CLI can override.
  workers: 2,
  forbidOnly: !!process.env['CI'],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone-15-webkit',
      testIgnore: [SW_SPEC, REAL_SPEC],
      use: { ...devices['iPhone 15'], browserName: 'webkit', serviceWorkers: 'block' },
    },
    {
      name: 'pixel-7-chromium-sw',
      testMatch: SW_SPEC,
      use: {
        ...devices['Pixel 7'],
        serviceWorkers: 'allow',
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
    {
      name: 'pixel-7-chromium-real-stack',
      testMatch: REAL_SPEC,
      use: {
        ...devices['Pixel 7'],
        serviceWorkers: 'block',
        timezoneId: 'Europe/Copenhagen',
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    },
  ],
  webServer: {
    // Built by the `e2e` script first: one long-lived process that Playwright can stop (a shell chain left
    // `vite preview` orphaned and hung CI after the tests passed).
    command: 'vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
  },
});
