import type { BookView, BooksResponse } from '@vault-companion/contracts';
import { useState } from 'react';
import { getBooks } from '../api.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { currentBook, isFinishedBook, progressPercent, reflectionOrdinals, reflectionsNewestFirst } from '../reading.ts';
import { CopyNote, useLastCopy } from './useLastCopy.tsx';
import { ChallengeSheet } from './ChallengeSheet.tsx';
import { ReadingSheet, type ReadingSheetKind } from './ReadingSheet.tsx';

/**
 * READ1-A2 / READ1-B: the Log tab's Reading view (ADR-0062, ADR-0063). No streaks, targets or standing AI text —
 * books, progress and reflections; a saved reflection can ask for one AI question on demand (marked as AI).
 */
export function Reading({ refreshKey, accountKey, queue, baseRevision, open, onClose }: {
  refreshKey: number | null; accountKey: string | null; queue: PendingQueue; baseRevision: string | null;
  /** The bottom-bar + is pressed: the log sheet for the current book, or the start sheet when there is none. */
  open: boolean; onClose: () => void;
}) {
  const view = useLastCopy<BooksResponse>(accountKey, 'books', getBooks, refreshKey);
  const res = view.res;
  const read = res?.kind === 'ok' ? res.data : null;
  const books = read?.status === 'ok' ? read.books : [];
  const [picked, setPicked] = useState<string | null>(null);
  const current = books.find((book) => book.title === picked) ?? currentBook(books);
  const others = books.filter((book) => book !== current);
  const [requested, setRequested] = useState<ReadingSheetKind | null>(null);
  // The Reflect draft lives here, so closing the sheet never loses what was typed.
  const [reflection, setReflection] = useState('');
  // READ1-B: the one reflection being challenged, with its book and ADR-0063 ordinal, so a refresh that repicks the
  // current book never retargets an open sheet.
  const [challenge, setChallenge] = useState<{ title: string; date: string; ordinal: number; text: string } | null>(null);
  const sheet: ReadingSheetKind | null = requested ?? (open && read?.status === 'ok' ? (current ? 'log' : 'start') : null);
  const close = () => { setRequested(null); onClose(); };
  const percent = current ? progressPercent(current.currentPage, current.totalPages) : 0;
  const shownReflections = current ? reflectionsNewestFirst(current.reflections) : [];
  const ordinals = reflectionOrdinals(shownReflections);
  return <section className="group reading" aria-label="Reading">
    <CopyNote view={view} />
    {!res && <p className="muted">Loading reading…</p>}
    {res && !read && <p className="muted">Reading could not be loaded. Refresh when connected.</p>}
    {read?.status === 'refused' && <p className="error">{read.message}</p>}
    {read?.status === 'ok' && books.length === 0 && (
      <div className="reading-empty">
        <p className="muted">No books yet.</p>
        <button type="button" className="primary" onClick={() => setRequested('start')}>Start a book</button>
      </div>
    )}
    {read?.status === 'ok' && current && (
      <article className="reading-current" data-testid="reading-current">
        <h3>{current.title}</h3>
        <p className="muted small">{current.author}</p>
        <p>page {current.currentPage} of {current.totalPages}</p>
        <div className="reading-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
          <span style={{ width: `${percent}%` }} />
        </div>
        {isFinishedBook(current) && <p className="reading-finished">Finished</p>}
        <div className="reading-actions">
          <button type="button" onClick={() => setRequested('log')}>Log pages</button>
          <button type="button" onClick={() => setRequested('reflect')}>Reflect</button>
        </div>
      </article>
    )}
    {read?.status === 'ok' && current && (
      <section className="reading-reflections" aria-label="Reflections">
        <h3>Reflections</h3>
        {current.reflections.length === 0 && <p className="muted">No reflections yet.</p>}
        <ul>{shownReflections.map((reflection, index) => (
          <li key={`${reflection.date}#${index}`} data-testid="reading-reflection">
            {reflection.text.length > 160
              ? <details><summary>{reflection.date}</summary><p>{reflection.text}</p>
                  <button type="button" className="reading-challenge"
                    onClick={() => setChallenge({ title: current.title, date: reflection.date, ordinal: ordinals[index]!, text: reflection.text })}>Challenge me</button></details>
              : <><p><span className="muted small">{reflection.date}</span> {reflection.text}</p>
                  <button type="button" className="reading-challenge"
                    onClick={() => setChallenge({ title: current.title, date: reflection.date, ordinal: ordinals[index]!, text: reflection.text })}>Challenge me</button></>}
          </li>))}
        </ul>
      </section>
    )}
    {read?.status === 'ok' && others.length > 0 && (
      <ul className="reading-books" aria-label="Other books">
        {others.map((book: BookView) => <li key={book.title}>
          <button type="button" onClick={() => setPicked(book.title)}>
            <strong>{book.title}</strong>{' '}
            <span className="muted small">{book.author} · page {book.currentPage} of {book.totalPages}{book.status === 'reading' ? '' : ` · ${book.status}`}</span>
          </button>
        </li>)}
      </ul>
    )}
    {sheet === 'start' && <ReadingSheet kind="start" queue={queue} accountKey={accountKey} baseRevision={baseRevision} onClose={close} />}
    {sheet === 'log' && current && <ReadingSheet kind="log" book={current} queue={queue} accountKey={accountKey} baseRevision={baseRevision} onClose={close} />}
    {sheet === 'reflect' && current && <ReadingSheet kind="reflect" book={current} draft={reflection} onDraftChange={setReflection} queue={queue} accountKey={accountKey} baseRevision={baseRevision} onClose={close} />}
    {challenge && <ChallengeSheet title={challenge.title} date={challenge.date} ordinal={challenge.ordinal} text={challenge.text}
      queue={queue} accountKey={accountKey} baseRevision={baseRevision} onClose={() => setChallenge(null)} />}
  </section>;
}
