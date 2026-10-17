export const VAULT_READ_CONCURRENCY = 6;

// Maps `items` through `fn` with at most `limit` calls pending at once; results keep input order.
// The first rejection rejects the result and no new calls start after it.
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new RangeError(`mapBounded limit must be >= 1, got ${limit}`);
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      if (failed || i >= items.length) return;
      next = i + 1;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
