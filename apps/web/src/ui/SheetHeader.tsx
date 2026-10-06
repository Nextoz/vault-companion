import type { ReactNode } from 'react';

/** Shared sticky title and dismissal; callers keep their existing save/draft guards. */
export function SheetHeader({ title, titleId, onClose, disabled = false, closeLabel = 'Close' }: {
  title: ReactNode;
  titleId?: string;
  onClose: () => void;
  disabled?: boolean;
  closeLabel?: string;
}) {
  return <div className="sheet-header">
    <h2 id={titleId}>{title}</h2>
    <button type="button" disabled={disabled} onClick={onClose}>{closeLabel}</button>
  </div>;
}
