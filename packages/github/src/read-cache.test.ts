// SP2 read cache: per-store-instance, exact (commit SHA, path) keyed, immutable 40-hex commits only.
// Synthetic fixtures only; no private vault text, no live network.
import { FileTooLarge, StoreUnavailable, type VaultPath } from '@vault-companion/domain';
import { describe, expect, it } from 'vitest';
import { GitHubContentsStore } from './contents-store.ts';

const PATH = 'Tasks/To-Do List.md' as VaultPath;
const SHA = (c: string) => c.repeat(40);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fileResponse(text: string, blobSha = SHA('b')): Response {
  return json(200, {
    type: 'file',
    sha: blobSha,
    size: new TextEncoder().encode(text).length,
    encoding: 'base64',
    content: btoa(text),
  });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function store(handler: Handler, owner = 'o', repo = 'r', token = 'tkn') {
  const calls: { url: string; init: RequestInit }[] = [];
  const s = new GitHubContentsStore({
    owner,
    repo,
    token: async () => token,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { s, calls };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const contentCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('/contents/')).length;

describe('read cache (SP2)', () => {
  it('Lead review: a malformed 200 response without file type is not confirmed absence', async () => {
    const { s } = store(() => json(200, { sha: SHA('b'), size: 3, encoding: 'base64', content: btoa('bad') }));
    await expect(s.readFile(PATH, SHA('a'))).rejects.toBeInstanceOf(StoreUnavailable);
  });

  it('Lead review: valid concurrent files remain present even when settlement evicts their cache entries', async () => {
    const { s, calls } = store(() => fileResponse('present'));
    const files = await Promise.all(Array.from({ length: 160 }, (_, i) =>
      s.readFile(`Inbox/Concurrent ${i}.md` as VaultPath, SHA('a'))));
    expect(files.filter((file) => file === null)).toHaveLength(0);
    expect(files.every((file) => file && decode(file.bytes) === 'present')).toBe(true);
    expect(contentCalls(calls)).toBe(160);
  });

  it('Lead review: malformed missing blob SHA cannot poison a later valid read', async () => {
    let n = 0;
    const { s, calls } = store(() => n++ === 0
      ? json(200, { type: 'file', size: 3, encoding: 'base64', content: btoa('bad') })
      : fileResponse('good'));
    await s.readFile(PATH, SHA('a')).catch(() => null);
    const recovered = await s.readFile(PATH, SHA('a'));
    expect(recovered?.blobSha).toBe(SHA('b'));
    expect(recovered && decode(recovered.bytes)).toBe('good');
    expect(contentCalls(calls)).toBe(2);
  });

  it('serves sequential identical immutable reads from the cache and copies bytes for every caller', async () => {
    let contentGets = 0;
    const { s, calls } = store((url) => {
      if (url.includes('/contents/')) contentGets += 1;
      return fileResponse('Hello');
    });

    const first = (await s.readFile(PATH, SHA('a')))!;
    const second = (await s.readFile(PATH, SHA('a')))!;
    first.bytes[0] = 0;
    const third = (await s.readFile(PATH, SHA('a')))!;

    expect(contentGets).toBe(1);
    expect(contentCalls(calls)).toBe(1);
    expect(decode(second.bytes)).toBe('Hello');
    expect(decode(third.bytes)).toBe('Hello');
    expect(first.bytes).not.toBe(second.bytes);
    expect(first.bytes).not.toBe(third.bytes);
    expect(first.commitSha).toBe(SHA('a'));
    expect(first.blobSha).toBe(SHA('b'));
  });

  it('always refetches head; a moved head returns changed bytes while the prior revision stays exact', async () => {
    let headCalls = 0;
    const contents: string[] = [];
    const { s } = store((url) => {
      const u = url.replace('https://api.github.com/repos/o/r', '');
      if (u === '/git/ref/heads/main') {
        headCalls += 1;
        return json(200, { object: { sha: headCalls === 1 ? SHA('a') : SHA('b') } });
      }
      if (u.startsWith('/contents/')) {
        contents.push(u);
        return fileResponse(u.includes(`ref=${SHA('a')}`) ? 'old' : 'new', SHA('c'));
      }
      return json(404, {});
    });

    const h1 = await s.head();
    expect(h1.commitSha).toBe(SHA('a'));
    expect(decode((await s.readFile(PATH, h1.commitSha))!.bytes)).toBe('old');

    const h2 = await s.head();
    expect(h2.commitSha).toBe(SHA('b'));
    expect(decode((await s.readFile(PATH, h2.commitSha))!.bytes)).toBe('new');
    expect(decode((await s.readFile(PATH, SHA('a')))!.bytes)).toBe('old');

    expect(headCalls).toBe(2);
    expect(contents).toHaveLength(2);
  });

  it('single-flights concurrent identical immutable reads and copies each settled result', async () => {
    let contentGets = 0;
    let resolve!: (r: Response) => void;
    const gate = new Promise<Response>((r) => {
      resolve = r;
    });
    const { s, calls } = store((url) => {
      if (url.includes('/contents/')) {
        contentGets += 1;
        return gate;
      }
      return json(404, {});
    });

    const p1 = s.readFile(PATH, SHA('a'));
    const p2 = s.readFile(PATH, SHA('a'));
    resolve(fileResponse('shared'));
    const [f1, f2] = await Promise.all([p1, p2]);

    expect(contentGets).toBe(1);
    expect(contentCalls(calls)).toBe(1);
    expect(decode(f1!.bytes)).toBe('shared');
    expect(decode(f2!.bytes)).toBe('shared');
    expect(f1!.bytes).not.toBe(f2!.bytes);

    const after = (await s.readFile(PATH, SHA('a')))!;
    expect(contentGets).toBe(1);
    expect(after.bytes).not.toBe(f1!.bytes);
  });

  it('fetches another path or commit independently', async () => {
    let contentGets = 0;
    const { s } = store((url) => {
      if (url.includes('/contents/')) contentGets += 1;
      return fileResponse('x');
    });

    await s.readFile('Tasks/A.md' as VaultPath, SHA('a'));
    await s.readFile('Tasks/B.md' as VaultPath, SHA('a'));
    await s.readFile('Tasks/A.md' as VaultPath, SHA('b'));

    expect(contentGets).toBe(3);
  });

  it('never shares returned private bytes or fetch calls between stores with different contexts', async () => {
    const a = store((_url) => fileResponse('alpha', SHA('1')), 'oa', 'ra', 'token-a');
    const b = store((_url) => fileResponse('beta', SHA('2')), 'ob', 'rb', 'token-b');

    const fa = (await a.s.readFile(PATH, SHA('a')))!;
    const fb = (await b.s.readFile(PATH, SHA('a')))!;

    expect(decode(fa.bytes)).toBe('alpha');
    expect(decode(fb.bytes)).toBe('beta');
    expect(fa.blobSha).toBe(SHA('1'));
    expect(fb.blobSha).toBe(SHA('2'));
    expect(a.calls.every((c) => c.url.includes('/repos/oa/ra/'))).toBe(true);
    expect(b.calls.every((c) => c.url.includes('/repos/ob/rb/'))).toBe(true);

    fa.bytes[0] = 0;
    const again = (await a.s.readFile(PATH, SHA('a')))!;
    expect(decode(again.bytes)).toBe('alpha');
  });

  it('never caches null, error, malformed or oversized answers; recovery issues a new GET', async () => {
    const responses = [
      json(404, {}),
      json(503, {}),
      json(200, { type: 'file', sha: SHA('b'), size: 2_000_000, encoding: 'none', content: '' }),
      fileResponse('ok'),
    ];
    let n = 0;
    const { s, calls } = store(() => responses[Math.min(n++, responses.length - 1)]!);

    expect(await s.readFile(PATH, SHA('a'))).toBeNull();
    await expect(s.readFile(PATH, SHA('a'))).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(s.readFile(PATH, SHA('a'))).rejects.toBeInstanceOf(FileTooLarge);
    expect(decode((await s.readFile(PATH, SHA('a')))!.bytes)).toBe('ok');
    expect(contentCalls(calls)).toBe(4);

    expect(decode((await s.readFile(PATH, SHA('a')))!.bytes)).toBe('ok');
    expect(contentCalls(calls)).toBe(4);
  });

  it('still refuses unsafe paths before lookup and never caches a non-SHA ref', async () => {
    let contentGets = 0;
    const { s } = store((url) => {
      if (url.includes('/contents/')) contentGets += 1;
      return fileResponse('x');
    });

    await s.readFile(PATH, SHA('a'));
    await expect(s.readFile('../x.md' as VaultPath, SHA('a'))).rejects.toThrow('unsafe vault path');
    expect(contentGets).toBe(1);

    await s.readFile(PATH, 'main');
    await s.readFile(PATH, 'main');
    expect(contentGets).toBe(3);
  });

  it('clears a failed single-flight so the next identical read retries', async () => {
    let n = 0;
    const { s, calls } = store(() => (n++ === 0 ? json(503, {}) : fileResponse('recovered')));

    const p1 = s.readFile(PATH, SHA('a'));
    const p2 = s.readFile(PATH, SHA('a'));
    await expect(p1).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(p2).rejects.toBeInstanceOf(StoreUnavailable);

    expect(decode((await s.readFile(PATH, SHA('a')))!.bytes)).toBe('recovered');
    expect(contentCalls(calls)).toBe(2);
  });

  it('evicts the oldest entry beyond 128 and re-fetches it externally', async () => {
    const paths = Array.from({ length: 129 }, (_, i) => `Inbox/Note ${i}.md` as VaultPath);
    const counts = new Map<string, number>();
    const { s, calls } = store((url) => {
      const p = decodeURIComponent(url.split('/contents/')[1]!.split('?ref=')[0]!);
      counts.set(p, (counts.get(p) ?? 0) + 1);
      return fileResponse(`note ${p}`);
    });

    for (const p of paths) await s.readFile(p, SHA('a'));
    const first = paths[0]!;
    expect(counts.get(first)).toBe(1);

    await s.readFile(first, SHA('a'));
    expect(counts.get(first)).toBe(2);
    expect(contentCalls(calls)).toBe(130);
  });

  it('evicts once resident bytes exceed 8 MiB and re-fetches the evicted entry', async () => {
    const big = 'x'.repeat(1024 * 1024);
    const counts = new Map<string, number>();
    const { s, calls } = store((url) => {
      const p = decodeURIComponent(url.split('/contents/')[1]!.split('?ref=')[0]!);
      counts.set(p, (counts.get(p) ?? 0) + 1);
      return fileResponse(p === 'Inbox/Small.md' ? 'x' : big);
    });

    for (let i = 0; i < 8; i += 1) await s.readFile(`Inbox/Big ${i}.md` as VaultPath, SHA('a'));
    await s.readFile('Inbox/Small.md' as VaultPath, SHA('a'));
    expect(counts.get('Inbox/Big 0.md')).toBe(1);

    await s.readFile('Inbox/Big 0.md' as VaultPath, SHA('a'));
    expect(counts.get('Inbox/Big 0.md')).toBe(2);
    expect(contentCalls(calls)).toBe(10);
  });

  it('single-flight joiners keep their fetched bytes when other insertions evict the key first', async () => {
    let resolve!: (r: Response) => void;
    const gate = new Promise<Response>((r) => {
      resolve = r;
    });
    const { s } = store((url) => {
      if (url.includes('/contents/Tasks/To-Do%20List.md')) return gate;
      return fileResponse('filler');
    });

    const p1 = s.readFile(PATH, SHA('a'));
    const p2 = s.readFile(PATH, SHA('a'));
    for (let i = 0; i < 128; i += 1) await s.readFile(`Inbox/Filler ${i}.md` as VaultPath, SHA('a'));

    resolve(fileResponse('present'));
    const [f1, f2] = await Promise.all([p1, p2]);
    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(decode(f1!.bytes)).toBe('present');
    expect(decode(f2!.bytes)).toBe('present');
    expect(f1!.bytes).not.toBe(f2!.bytes);
  });

  it('retries a confirmed absence with a fresh GET and never caches null', async () => {
    let contentGets = 0;
    const { s, calls } = store((url) => {
      if (url.includes('/contents/')) contentGets += 1;
      return json(404, {});
    });

    expect(await s.readFile(PATH, SHA('a'))).toBeNull();
    expect(await s.readFile(PATH, SHA('a'))).toBeNull();
    expect(contentGets).toBe(2);
    expect(contentCalls(calls)).toBe(2);
  });

  it.each([
    ['missing blob SHA', { type: 'file', size: 3, encoding: 'base64', content: btoa('bad') }, StoreUnavailable],
    ['non-hex blob SHA', { type: 'file', sha: SHA('z'), size: 3, encoding: 'base64', content: btoa('bad') }, StoreUnavailable],
    ['negative size', { type: 'file', sha: SHA('b'), size: -1, encoding: 'base64', content: btoa('bad') }, StoreUnavailable],
    ['fractional size', { type: 'file', sha: SHA('b'), size: 3.5, encoding: 'base64', content: btoa('bad') }, StoreUnavailable],
    ['non-base64 encoding', { type: 'file', sha: SHA('b'), size: 3, encoding: 'none', content: btoa('bad') }, StoreUnavailable],
    ['non-string content', { type: 'file', sha: SHA('b'), size: 3, encoding: 'base64', content: 123 }, StoreUnavailable],
    ['invalid base64', { type: 'file', sha: SHA('b'), size: 3, encoding: 'base64', content: '***' }, StoreUnavailable],
    ['inconsistent size', { type: 'file', sha: SHA('b'), size: 3, encoding: 'base64', content: btoa('four') }, StoreUnavailable],
  ])('rejects %s and recovers with a fresh GET', async (_label, body, errorType) => {
    let n = 0;
    const { s, calls } = store(() => (n++ === 0 ? json(200, body) : fileResponse('ok')));

    await expect(s.readFile(PATH, SHA('a'))).rejects.toBeInstanceOf(errorType);
    const recovered = await s.readFile(PATH, SHA('a'));
    expect(decode(recovered!.bytes)).toBe('ok');
    expect(contentCalls(calls)).toBe(2);
  });

  it('refuses base64 whose decoded bytes exceed 1 MiB before treating it as a file', async () => {
    const { s } = store(() => json(200, {
      type: 'file',
      sha: SHA('b'),
      size: 1024 * 1024,
      encoding: 'base64',
      content: 'A'.repeat(Math.ceil((1024 * 1024 + 1) / 3) * 4),
    }));

    await expect(s.readFile(PATH, SHA('a'))).rejects.toBeInstanceOf(FileTooLarge);
  });
});
