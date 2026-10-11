import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Shared sticky title and dismissal; callers keep their existing save/draft guards. With `onBack`, a leading
 * "‹ <backLabel>" returns to the sheet's previous page (its accessible name starts with "Back").
 * The header marks itself `data-scrolled` while its scrolling sheet (the parent) is scrolled, for the hairline.
 */
export function SheetHeader({ title, titleId, onClose, disabled = false, closeLabel = 'Close', onBack, backLabel }: {
  title: ReactNode;
  titleId?: string;
  onClose: () => void;
  disabled?: boolean;
  closeLabel?: string;
  onBack?: () => void;
  backLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const header = ref.current;
    const scroller = header?.parentElement;
    if (!header || !scroller) return;
    const mark = () => header.toggleAttribute('data-scrolled', scroller.scrollTop > 0);
    mark();
    scroller.addEventListener('scroll', mark, { passive: true });
    return () => scroller.removeEventListener('scroll', mark);
  }, []);
  return <div className="sheet-header" ref={ref}>
    {onBack && <button type="button" className="sheet-back" aria-label={`Back to ${backLabel ?? 'previous'}`} onClick={onBack}>
      <span aria-hidden="true">‹ {backLabel ?? 'Back'}</span>
    </button>}
    <h2 id={titleId}>{title}</h2>
    <button type="button" disabled={disabled} onClick={onClose}>{closeLabel}</button>
  </div>;
}
