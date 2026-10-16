import { useEffect, useRef, type ReactNode } from 'react';
import { useSheetDismiss } from './sheet-motion.ts';

/**
 * Shared sticky title and dismissal; callers keep their existing save/draft guards. With `onBack`, a leading
 * "‹ <backLabel>" returns to the sheet's previous page (its accessible name starts with "Back").
 * The header marks itself `data-scrolled` while its scrolling sheet (the parent) is scrolled, for the hairline.
 * R2: the header carries the grabber, so dragging it down dismisses the sheet (sheet-motion.ts); Close slides the
 * sheet out first. A header whose Close only goes back a page (onClose === onBack) is navigation, not dismissal.
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
  const { close, handlers } = useSheetDismiss(ref, onClose, !disabled && onClose !== onBack);
  useEffect(() => {
    const header = ref.current;
    const scroller = header?.parentElement;
    if (!header || !scroller) return;
    const mark = () => header.toggleAttribute('data-scrolled', scroller.scrollTop > 0);
    mark();
    scroller.addEventListener('scroll', mark, { passive: true });
    return () => scroller.removeEventListener('scroll', mark);
  }, []);
  return <div className="sheet-header" ref={ref} {...handlers}>
    {onBack && <button type="button" className="sheet-back" aria-label={`Back to ${backLabel ?? 'previous'}`} onClick={onBack}>
      <span aria-hidden="true">‹ {backLabel ?? 'Back'}</span>
    </button>}
    <h2 id={titleId}>{title}</h2>
    <button type="button" disabled={disabled} onClick={close}>{closeLabel}</button>
  </div>;
}
