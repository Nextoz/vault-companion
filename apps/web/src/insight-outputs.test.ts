import { describe, expect, it, vi } from 'vitest';
import { createOutputLoader } from './insight-outputs.ts';

describe('createOutputLoader', () => {
  it('reads a successful output once per scout and revision', async () => {
    const fetch = vi.fn(async () => '- Tea');
    const load = createOutputLoader(fetch);
    expect(await load('r1', 'learning')).toEqual({ state: 'ready', picks: [{ text: 'Tea', details: [] }] });
    await load('r1', 'learning');
    expect(fetch).toHaveBeenCalledTimes(1);
    await load('r2', 'learning');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retries an unavailable or failed read on the next call instead of caching it', async () => {
    const fetch = vi.fn<(id: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('- Tea');
    const load = createOutputLoader(fetch);
    expect(await load('r1', 'learning')).toEqual({ state: 'unavailable' });
    expect(await load('r1', 'learning')).toEqual({ state: 'unavailable' });
    expect(await load('r1', 'learning')).toMatchObject({ state: 'ready' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('shares one in-flight read between callers', async () => {
    let resolve: (value: string) => void = () => {};
    const fetch = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const load = createOutputLoader(fetch);
    const both = Promise.all([load('r1', 'learning'), load('r1', 'learning')]);
    resolve('- Tea');
    expect((await both).map((o) => o.state)).toEqual(['ready', 'ready']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
