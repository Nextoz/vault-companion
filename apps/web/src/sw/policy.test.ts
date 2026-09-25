import { describe, expect, it } from 'vitest';
import { isCacheableShell, strategyFor } from './policy.ts';

const origin = 'https://vc.example';
const s = (path: string, method = 'GET', mode = 'cors') => strategyFor(new URL(path, origin), method, mode, origin);

describe('service worker policy', () => {
  it('never intercepts the API, even for navigations', () => {
    expect(s('/api/tasks')).toBe('bypass');
    expect(s('/api/linked-note')).toBe('bypass'); // P4-A: note text is never cached
    expect(s('/api/session', 'GET', 'navigate')).toBe('bypass');
    expect(s('/api')).toBe('bypass');
    expect(s('/api/commands', 'POST')).toBe('bypass');
  });

  it('caches the shell and hashed assets only', () => {
    expect(s('/', 'GET', 'navigate')).toBe('shell');
    expect(s('/index.html')).toBe('shell');
    expect(s('/assets/index-abc123.js')).toBe('asset');
    expect(s('/manifest.webmanifest')).toBe('bypass');
    expect(s('/assets/x.js', 'POST')).toBe('bypass');
    expect(strategyFor(new URL('https://other.example/assets/x.js'), 'GET', 'cors', origin)).toBe('bypass');
  });

  it('does not accept a non-HTML or failed shell response', () => {
    const html = { 'Content-Type': 'text/html; charset=utf-8' };
    expect(isCacheableShell(new Response('<!doctype html>', { headers: html }))).toBe(false); // type 'default'
    const basic = (init: ResponseInit) => {
      const r = new Response('x', init);
      Object.defineProperty(r, 'type', { value: 'basic' });
      return r;
    };
    expect(isCacheableShell(basic({ headers: html }))).toBe(true);
    expect(isCacheableShell(basic({ status: 500, headers: html }))).toBe(false);
    expect(isCacheableShell(basic({ headers: { 'Content-Type': 'application/json' } }))).toBe(false);
  });
});
