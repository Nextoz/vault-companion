import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MockApi, taskView } from './mock-api.ts';
import { StaticServer } from './static-server.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const HEADERS_FILE = fileURLToPath(new URL('../public/_headers', import.meta.url));

export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue;
    const colon = trimmed.indexOf(':');
    if (colon > 0) {
      headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
    }
  }
  return headers;
}

test.describe('production CSP headers', () => {
  let server: StaticServer;
  let origin: string;
  let expectedHeaders: Record<string, string>;

  test.beforeAll(async () => {
    const raw = await readFile(HEADERS_FILE, 'utf8');
    expectedHeaders = parseHeaders(raw);
    expect(expectedHeaders['Content-Security-Policy']).toBeTruthy();
    // The guard itself: scripts only from our origin (no 'unsafe-eval', 'unsafe-inline' or extra hosts).
    const scriptSrc = expectedHeaders['Content-Security-Policy']!.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self'");
    server = new StaticServer(DIST, expectedHeaders);
    await server.listen(0);
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await server?.close();
  });

  test('built app served with production _headers loads and opens a linked note without CSP violations', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-24T10:00:00Z') });

    const api = new MockApi();
    api.open = [
      taskView(14, 'Prepare [[Projects/Garden/Plan|the garden plan]]', {
        links: ['Projects/Garden/Plan'],
      }),
    ];
    api.notes.set('Projects/Garden/Plan', {
      path: 'Projects/Garden/Plan.md',
      markdown: [
        '# Beds',
        '',
        'Sow **carrots** in row 3. See [[Seeds]] and [the almanac](https://example.com/almanac).',
      ].join('\n'),
    });
    await api.install(page);

    const cspViolations: Array<{
      blockedURI: string;
      violatedDirective: string;
      effectiveDirective: string;
      originalPolicy: string;
    }> = [];
    const cspConsoleErrors: string[] = [];

    await page.exposeFunction('__reportCspViolation', (violation: {
      blockedURI: string;
      violatedDirective: string;
      effectiveDirective: string;
      originalPolicy: string;
    }) => {
      cspViolations.push(violation);
    });

    page.on('console', (msg) => {
      const text = msg.text();
      if (
        msg.type() === 'error' ||
        /content[- ]security[- ]policy/i.test(text) ||
        /violat(es|ed).*directive/i.test(text) ||
        /refused to (load|apply|execute|send|connect)/i.test(text)
      ) {
        cspConsoleErrors.push(text);
      }
    });

    await page.addInitScript(() => {
      const seen = new WeakSet<Event>();
      const handler = (e: Event) => {
        if (seen.has(e)) return;
        seen.add(e);
        const ev = e as SecurityPolicyViolationEvent;
        // Recorded synchronously in the page, so the final check never races the exposed-function round trip.
        const w = window as unknown as { __cspViolations?: string[] };
        (w.__cspViolations ??= []).push(`${ev.effectiveDirective} ${ev.blockedURI}`);
        void (window as unknown as { __reportCspViolation?: (r: unknown) => void }).__reportCspViolation?.({
          blockedURI: ev.blockedURI,
          violatedDirective: ev.violatedDirective,
          effectiveDirective: ev.effectiveDirective,
          originalPolicy: ev.originalPolicy,
          sourceFile: ev.sourceFile,
          lineNumber: ev.lineNumber,
          sample: ev.sample,
        });
      };
      window.addEventListener('securitypolicyviolation', handler, true);
      document.addEventListener('securitypolicyviolation', handler, true);
    });

    const response = await page.goto(`${origin}/`);
    expect(response?.status()).toBe(200);
    // Confirm the response actually received the header CSP
    expect(response?.headers()['content-security-policy']).toBe(expectedHeaders['Content-Security-Policy']);

    // The app shell loads and shows the task
    const openNoteButton = page.getByRole('button', { name: 'Open note: the garden plan' });
    await expect(openNoteButton).toBeVisible();

    // Open the linked note dialog
    await openNoteButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Plan' })).toBeVisible();
    await expect(dialog).toContainText('Read-only');

    const body = dialog.getByTestId('note-body');
    await expect(body.getByRole('heading', { name: 'Beds' })).toBeVisible();
    await expect(body.locator('strong')).toHaveText('carrots');

    // Assert no CSP violations were reported via events or console errors
    expect(cspViolations).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])).toEqual([]);
    expect(cspConsoleErrors).toEqual([]);
  });
});
