import { StartBookPayload, type BookView } from '@vault-companion/contracts';
import { useRef, useState } from 'react';
import { logReading, saveReflection, startBook } from '../commands.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { defaultReadingDate, pageError } from '../reading.ts';
import { SheetHeader } from './SheetHeader.tsx';

/** READ1-A2: one sheet for the three reading actions. Start has no queue picker (v1); Reflect keeps its draft outside. */
export type ReadingSheetKind = 'start' | 'log' | 'reflect';

export function ReadingSheet({ kind, book, queue, accountKey, baseRevision, onClose, now = new Date(), draft = '', onDraftChange }: {
  kind: ReadingSheetKind;
  book?: BookView | undefined;
  queue: PendingQueue;
  accountKey: string | null;
  baseRevision: string | null;
  onClose: () => void;
  now?: Date;
  /** The Reflect draft, held by the screen so closing the sheet never loses it. */
  draft?: string;
  onDraftChange?: (text: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [totalPages, setTotalPages] = useState('');
  const [page, setPage] = useState(() => (book ? String(book.currentPage) : ''));
  const [date, setDate] = useState(() => defaultReadingDate(now.toISOString()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guard = useRef(false);
  const startParsed = StartBookPayload.safeParse({ title: title.trim(), author: author.trim(), totalPages: Number(totalPages) });
  const startReady = startParsed.success && title.trim() !== '' && author.trim() !== '';
  const typedPage = page.trim() === '' ? Number.NaN : Number(page);
  const pageProblem = book ? pageError(typedPage, book.currentPage, book.totalPages) : 'No book is open.';
  const ready = kind === 'start' ? startReady : kind === 'log' ? pageProblem === null : draft.trim() !== '';
  const heading = kind === 'start' ? 'Start a book' : kind === 'log' ? 'Log pages' : 'Reflect';

  const save = async () => {
    if (!ready || !accountKey || !baseRevision || guard.current) return;
    guard.current = true; setSaving(true); setError(null);
    try {
      if (kind === 'start' && startParsed.success) {
        await queue.enqueue(startBook({ baseRevision }, startParsed.data),
          { accountKey, label: `${startParsed.data.title} · start`, taskKey: 'reading' });
      } else if (kind === 'log' && book) {
        await queue.enqueue(logReading({ baseRevision }, { title: book.title, page: typedPage, date }),
          { accountKey, label: `${book.title} · p. ${typedPage}`, taskKey: 'reading' });
      } else if (kind === 'reflect' && book) {
        // The text travels verbatim and never reaches a label, a log or an error string.
        await queue.enqueue(saveReflection({ baseRevision }, { title: book.title, date, text: draft }),
          { accountKey, label: `${book.title} · reflection`, taskKey: 'reading' });
        onDraftChange?.('');
      } else return;
      onClose();
    } catch { setError('Could not keep this on the device. Your entry is still here.'); }
    finally { guard.current = false; setSaving(false); }
  };

  return <div className="sheet-backdrop" role="presentation"><form className="sheet reading-sheet" role="dialog" aria-modal="true" aria-label={heading}
    onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <SheetHeader title={heading} onClose={onClose} disabled={saving} />
    {kind === 'start' && <>
      <label>Title<input type="text" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Author<input type="text" required maxLength={200} value={author} onChange={(e) => setAuthor(e.target.value)} /></label>
      <label>Total pages<input type="number" inputMode="numeric" required min="1" step="1" value={totalPages} onChange={(e) => setTotalPages(e.target.value)} /></label>
    </>}
    {kind === 'log' && book && <>
      <p className="muted small">{book.title}</p>
      <label>Page<input type="number" inputMode="numeric" required min="0" step="1" value={page} onChange={(e) => setPage(e.target.value)} /></label>
      {pageProblem && <p className="muted small" role="alert">{pageProblem}</p>}
      <label>Date<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
    </>}
    {kind === 'reflect' && book && <>
      <p className="muted small">{book.title}</p>
      <label>What stayed with me?<textarea rows={5} maxLength={20000} value={draft} onChange={(e) => onDraftChange?.(e.target.value)} /></label>
      <label>Date<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
    </>}
    {(!accountKey || !baseRevision) && <p>Connect once to set up this device before saving.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="sheet-buttons">
      <button type="submit" className="primary" disabled={saving || !ready || !accountKey || !baseRevision}>{kind === 'start' ? 'Start book' : 'Save'}</button>
    </div>
  </form></div>;
}
