export type ReadReason = 'wake' | 'refresh' | 'receipt';

/** Per read kind: wakes share pending work and a one-second completion window.
 * Explicit refresh bypasses the window; receipts must read after the saved action,
 * even when an older read is pending. No I/O or scheduling belongs here.
 */
export function coalescedRead<T>(read: () => Promise<T>, now: () => number = Date.now) {
  const pending = new Set<Promise<T>>();
  let completed: Promise<T> | undefined;
  let completedAt = -Infinity;

  return (reason: ReadReason = 'refresh'): Promise<T> => {
    if (reason !== 'receipt') {
      const active = [...pending].at(-1);
      if (active) return active;
      if (reason === 'wake' && completed && now() - completedAt < 1000) return completed;
    }
    const result = Promise.resolve().then(read).finally(() => {
      pending.delete(result);
      completed = result;
      completedAt = now();
    });
    pending.add(result);
    return result;
  };
}
