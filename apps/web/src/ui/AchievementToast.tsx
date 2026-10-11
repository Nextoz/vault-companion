import type { GameResponse } from '@vault-companion/contracts';
import { useEffect, useRef, useState } from 'react';
import { planToasts, seenKey, summaryText, toastText, type SummaryToast, type ToastItem } from '../achievements.ts';
import { CharacterRead } from './CharacterRead.tsx';
import './Achievements.css';

/** Seen ids are optional device state: every read and write is guarded, so a throwing store costs only the record. */
function readSeen(account: string | null): readonly string[] | null {
  try {
    const raw = localStorage.getItem(seenKey(account));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return null;
  }
}

function writeSeen(account: string | null, ids: readonly string[]): void {
  try {
    localStorage.setItem(seenKey(account), JSON.stringify([...new Set(ids)]));
  } catch {
    // Private mode or storage disabled: the toast still shows once per open, it is just not remembered.
  }
}

const TOAST_CAP = 3;

/** Selects the toasts from one payload and marks what it shows as seen. Session refs guard a throwing store. */
function ToastPlanRunner({ data, accountKey }: { data: GameResponse; accountKey: string | null }) {
  const [summary, setSummary] = useState<SummaryToast | null>(null);
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  const shownIds = useRef(new Set<string>());
  const shownSummary = useRef(false);
  useEffect(() => {
    const seen = readSeen(accountKey);
    const plan = planToasts(data.character.achievements, data.stepMilestones, seen);
    if (plan.kind === 'summary') {
      if (shownSummary.current) return;
      shownSummary.current = true;
      setSummary(plan.summary);
      if (plan.seenIds.length > 0) writeSeen(accountKey, plan.seenIds);
      return;
    }
    if (plan.kind === 'individual') {
      const room = Math.max(0, TOAST_CAP - shownIds.current.size);
      const fresh = plan.items.filter((item) => !shownIds.current.has(item.id)).slice(0, room);
      if (fresh.length === 0) return;
      for (const item of fresh) shownIds.current.add(item.id);
      setItems((prev) => [...prev, ...fresh]);
      writeSeen(accountKey, [...(seen ?? []), ...fresh.map((item) => item.id)]);
    }
  }, [data, accountKey]);
  if (summary === null && items.length === 0) return null;
  // pointer-events: none on the stack (see Achievements.css): only the dismiss buttons ever take a tap.
  return <div className="achievement-toasts">
    {summary !== null && <div className="achievement-toast" role="status">
      <span>{summaryText(summary)}</span>
      <button type="button" className="achievement-toast-dismiss" aria-label="Dismiss" onClick={() => setSummary(null)}>×</button>
    </div>}
    {items.map((item) => <div key={item.id} className="achievement-toast" role="status">
      <span>{toastText(item)}</span>
      <button type="button" className="achievement-toast-dismiss" aria-label="Dismiss" onClick={() => setItems((prev) => prev.filter((row) => row.id !== item.id))}>×</button>
    </div>)}
  </div>;
}

/**
 * Screen 6: mounted by App on any tab. It reads the same /api/game the Log card reads once per app open, then, on this
 * device's first sighting, replaces the individual toasts with one summary; later opens announce up to three newly
 * earned ones. It never takes focus and is silent while signed out or when the read fails.
 */
export function AchievementToasts({ accountKey, signedOut }: { accountKey: string | null; signedOut: boolean }) {
  // Wait for the session's account so the seen record is always account-scoped (never the null fallback key).
  if (signedOut || accountKey === null) return null;
  return <CharacterRead refreshKey={null} accountKey={accountKey}>
    {({ data }) => data !== null
      ? <ToastPlanRunner key={accountKey ?? 'none'} data={data} accountKey={accountKey} />
      : null}
  </CharacterRead>;
}
