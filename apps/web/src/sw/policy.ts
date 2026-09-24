// What the service worker may cache (brief F): hashed static assets and index.html only; never /api/*.

export type Strategy = 'bypass' | 'shell' | 'asset';

export function strategyFor(url: URL, method: string, mode: string, origin: string): Strategy {
  if (method !== 'GET' || url.origin !== origin) return 'bypass';
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'bypass';
  if (mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') return 'shell';
  if (url.pathname.startsWith('/assets/')) return 'asset';
  return 'bypass';
}

/** Only a real app shell may replace the cached one — never an Access login page or an error. */
export function isCacheableShell(res: Response): boolean {
  return (
    res.ok &&
    res.type === 'basic' &&
    !res.redirected &&
    (res.headers.get('Content-Type') ?? '').startsWith('text/html')
  );
}
