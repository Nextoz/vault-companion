import { describe, expect, it } from 'vitest';
import raw from '../../web/public/_headers?raw';
import { SECURITY_HEADERS } from './app.ts';

/** Workers static-assets `_headers`: a URL pattern line, then indented `Name: value` lines. */
function parseHeaders(text: string): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = rules[line.trim()] = {};
      continue;
    }
    const m = /^\s+([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!m || !current) throw new Error(`unparseable _headers line: ${line}`);
    current[m[1]!] = m[2]!.trim();
  }
  return rules;
}

describe('apps/web/public/_headers', () => {
  it('gives every static response exactly the Worker security headers', () => {
    // Static assets bypass the Worker (run_worker_first: /api/* only), so app.ts cannot add these itself.
    expect(parseHeaders(raw)).toEqual({ '/*': SECURITY_HEADERS });
  });
});
