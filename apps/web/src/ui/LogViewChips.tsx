import { useLayoutEffect, useRef } from 'react';
import { LOG_VIEW_LABELS, LOG_VIEWS, type LogView } from '../log-view.ts';

/**
 * R3b (review #9): the Log's five views as the shared horizontally scrolling chip row (R3a `.chip-row`), the selected
 * chip filled. A remembered view off the right edge (Reading) is scrolled into the row on arrival.
 */
export function LogViewChips({ view, onSelect }: { view: LogView | null; onSelect: (view: LogView) => void }) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = row.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip) return;
    // Only the row scrolls (never the page); a chip already clear of the 16 px gutters (and their fade) stays put.
    const edge = el.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    const gutter = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    if (box.right > edge.right - gutter) el.scrollLeft += box.right - (edge.right - gutter);
    else if (box.left < edge.left + gutter) el.scrollLeft -= edge.left + gutter - box.left;
  }, [view]);
  return (
    <div ref={row} className="chip-row log-view" role="group" aria-label="Log view">
      {LOG_VIEWS.map((v) => (
        <button key={v} type="button" className="chip-row-item" aria-pressed={view === v} onClick={() => onSelect(v)}>
          {LOG_VIEW_LABELS[v]}
        </button>
      ))}
    </div>
  );
}
