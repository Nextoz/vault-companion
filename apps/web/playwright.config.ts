import { defineConfig, devices } from '@playwright/test';

const SW_SPEC = /offline-shell\.spec\.ts$/;
// Optional: a preinstalled Chromium when Playwright's own download is unavailable (e.g. cloud sandboxes).
const chromiumPath = process.env['PW_CHROMIUM_EXECUTABLE'];

// Against the production build (vite preview), API mocked per test.
// - WebKit on an iPhone 15 viewport: everything except the service worker, which is blocked there so
//   page.route sees every /api request (the SW never handles /api anyway).
// - Chromium: the service-worker offline shell only. Playwright can route service-worker traffic and emulate
//   offline for it in Chromium only, so those tests allow service workers and run there (docs/briefs/P2B-report.md).
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  reporter: 'list',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone-15-webkit',
      testIgnore: SW_SPEC,
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
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 },
  },
});
