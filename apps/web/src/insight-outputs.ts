import { topPicks, type InsightPick } from './insights.ts';

export type Output = { state: 'loading' } | { state: 'ready'; picks: InsightPick[] } | { state: 'unavailable' };

/**
 * One read per scout and vault revision while it is in flight or succeeded. An unavailable result is evicted once it
 * settles, so a transient failure is retried on the next page open instead of sticking for the whole revision.
 */
export function createOutputLoader(fetchMarkdown: (scoutId: string) => Promise<string | null>) {
  const cache = new Map<string, Promise<Output>>();
  return (revision: string, scoutId: string): Promise<Output> => {
    const key = `${revision}\n${scoutId}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const load = fetchMarkdown(scoutId).then(
      (markdown): Output => markdown === null ? { state: 'unavailable' } : { state: 'ready', picks: topPicks(markdown) },
      (): Output => ({ state: 'unavailable' }),
    );
    cache.set(key, load);
    void load.then((output) => { if (output.state === 'unavailable' && cache.get(key) === load) cache.delete(key); });
    return load;
  };
}
