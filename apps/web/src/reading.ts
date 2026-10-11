// READ1-A2: pure helpers for the Reading screen - book pick, progress, page validation, date default. No React here:
// the same rules are unit-tested without a DOM. `GET /api/books` (ADR-0062) is the only source these rules see.
import type { BookReflection, BookView } from '@vault-companion/contracts';
import { copenhagenDay } from './triage.ts';

/**
 * The book the screen leads with: the one being read with the latest `lastRead`. A `done` (or any other non-`reading`)
 * book is never picked, and when nothing is being read there is no current book. Equal dates keep the read's order.
 */
export function currentBook(books: readonly BookView[]): BookView | null {
  let best: BookView | null = null;
  for (const book of books) {
    if (book.status !== 'reading') continue;
    if (best === null || (book.lastRead ?? '') > (best.lastRead ?? '')) best = book;
  }
  return best;
}

/** Progress as a percentage, clamped to 0..100; an unknown or zero page count is 0, never a division by zero. */
export function progressPercent(currentPage: number, totalPages: number): number {
  if (!Number.isFinite(currentPage) || !Number.isFinite(totalPages) || totalPages <= 0) return 0;
  return Math.min(100, Math.max(0, (currentPage / totalPages) * 100));
}

/** A book whose latest page reached its page count is finished; a zero page count is never finished. */
export function isFinishedBook(book: Pick<BookView, 'currentPage' | 'totalPages'>): boolean {
  return book.totalPages > 0 && book.currentPage >= book.totalPages;
}

/**
 * Why a page cannot be logged, in plain words; `null` when it can. A page before the current one is blocked here, so
 * a mistyped backward page never leaves the device; the server's own rule (`page <= currentPage`) still answers with
 * a plain refusal for anything the client cannot see, e.g. an equal page on a stale read.
 */
export function pageError(page: number, currentPage: number, totalPages: number): string | null {
  if (!Number.isInteger(page)) return 'Enter the page you are on.';
  if (page < currentPage) return 'That page is before where you are now.';
  if (page > totalPages) return 'That page is past the end of the book.';
  return null;
}

/** The default date for a reading entry: the owner's Copenhagen calendar day. */
export function defaultReadingDate(now: string): string {
  return copenhagenDay(now);
}

/** Reflections newest first; same-day entries keep their order, so two reflections on one day stay two rows. */
export function reflectionsNewestFirst(reflections: readonly BookReflection[]): BookReflection[] {
  return reflections
    .map((reflection, index) => ({ reflection, index }))
    .sort((a, b) => (a.reflection.date === b.reflection.date ? a.index - b.index : a.reflection.date < b.reflection.date ? 1 : -1))
    .map(({ reflection }) => reflection);
}
