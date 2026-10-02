// SP3 (ADR-0038): a read-only screen's read, opened from the in-memory last copy when there is one.
import { useEffect, useState } from 'react';
import type { Fetched } from '../api.ts';
import { displayTime } from '../freshness.ts';
import { lastCopies, openView, settleView, type CopyView } from '../lastCopy.ts';

export function useLastCopy<T>(account: string | null, key: string, read: () => Promise<Fetched<T>>, refreshKey: number | null): CopyView<T> {
  const id = `${account ?? ''}\u0000${key}`;
  const [state, setState] = useState(() => ({ id, view: openView<T>(lastCopies, account, key) }));
  let current = state;
  if (state.id !== id) {
    current = { id, view: openView<T>(lastCopies, account, key) };
    setState(current);
  }
  useEffect(() => {
    let live = true;
    void read().then((fresh) => {
      if (live) setState((s) => (s.id === id ? { id, view: settleView(lastCopies, account, key, s.view, fresh, Date.now()) } : s));
    });
    return () => { live = false; };
  }, [id, refreshKey]);
  return current.view;
}

/** Says when the screen shows an earlier answer; nothing when it shows this read's. */
export function CopyNote({ view }: { view: CopyView<unknown> }) {
  if (view.copyAt === null) return null;
  const at = displayTime(view.copyAt, Date.now(), 'Europe/Copenhagen');
  return <p className="muted small" role="status" data-testid="copy-note">
    {view.failed ? `Could not refresh · showing the copy from ${at}` : `Showing the copy from ${at} · refreshing…`}
  </p>;
}
