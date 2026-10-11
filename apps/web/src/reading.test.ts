import type { BookView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { currentBook, defaultReadingDate, isFinishedBook, pageError, progressPercent, reflectionOrdinals, reflectionsNewestFirst } from './reading.ts';
import { VERB } from './ui/ActionsPanel.tsx';

const book = (over: Partial<BookView> = {}): BookView => ({
  title: 'Synthetic Book', author: 'A. Author', totalPages: 100, currentPage: 10,
  status: 'reading', lastRead: '2026-10-01', reflections: [], ...over,
});

describe('currentBook', () => {
  it('picks the reading book with the latest lastRead', () => {
    const older = book({ title: 'Older', lastRead: '2026-10-01' });
    const newer = book({ title: 'Newer', lastRead: '2026-10-05' });
    expect(currentBook([older, newer])?.title).toBe('Newer');
    expect(currentBook([newer, older])?.title).toBe('Newer');
  });
  it('never picks a done book over a reading one, even with a later lastRead', () => {
    const done = book({ title: 'Done', status: 'done', lastRead: '2026-10-09' });
    const reading = book({ title: 'Reading', lastRead: '2026-10-02' });
    expect(currentBook([done, reading])?.title).toBe('Reading');
  });
  it('is null when nothing is being read, and a never-read book sorts last', () => {
    expect(currentBook([book({ status: 'done' })])).toBeNull();
    expect(currentBook([])).toBeNull();
    const neverRead = book({ title: 'Never', lastRead: null });
    const started = book({ title: 'Started', lastRead: '2026-01-01' });
    expect(currentBook([neverRead, started])?.title).toBe('Started');
  });
});

describe('progressPercent', () => {
  it('clamps above 100 and below 0', () => {
    expect(progressPercent(150, 100)).toBe(100);
    expect(progressPercent(-5, 100)).toBe(0);
  });
  it('never divides by zero (or a negative or unknown page count)', () => {
    expect(progressPercent(10, 0)).toBe(0);
    expect(progressPercent(10, -3)).toBe(0);
    expect(progressPercent(10, Number.NaN)).toBe(0);
    expect(progressPercent(Number.NaN, 100)).toBe(0);
  });
  it('is the plain ratio inside the range', () => {
    expect(progressPercent(25, 50)).toBe(50);
  });
});

describe('isFinishedBook', () => {
  it('is true only once the last page is reached', () => {
    expect(isFinishedBook({ currentPage: 99, totalPages: 100 })).toBe(false);
    expect(isFinishedBook({ currentPage: 100, totalPages: 100 })).toBe(true);
    expect(isFinishedBook({ currentPage: 120, totalPages: 100 })).toBe(true);
    expect(isFinishedBook({ currentPage: 0, totalPages: 0 })).toBe(false);
  });
});

describe('pageError', () => {
  it('blocks a page before the current one, and anything past the end', () => {
    expect(pageError(9, 10, 100)).toMatch(/before where you are/);
    expect(pageError(101, 10, 100)).toMatch(/past the end/);
  });
  it('blocks a blank or fractional page', () => {
    expect(pageError(Number.NaN, 10, 100)).toMatch(/Enter the page/);
    expect(pageError(10.5, 10, 100)).toMatch(/Enter the page/);
  });
  it('allows the page the reader is on and any page ahead of it', () => {
    expect(pageError(10, 10, 100)).toBeNull();
    expect(pageError(50, 10, 100)).toBeNull();
  });
});

describe('defaultReadingDate', () => {
  it('is the Copenhagen calendar day, not UTC', () => {
    expect(defaultReadingDate('2026-10-11T22:30:00Z')).toBe('2026-10-12');
    expect(defaultReadingDate('2026-12-31T23:30:00Z')).toBe('2027-01-01');
  });
});

describe('reflectionsNewestFirst', () => {
  it('orders by date and keeps two same-day entries apart', () => {
    const first = { date: '2026-10-02', text: 'first' };
    const second = { date: '2026-10-05', text: 'second' };
    const third = { date: '2026-10-05', text: 'third' };
    expect(reflectionsNewestFirst([first, second, third])).toEqual([second, third, first]);
  });
  it('does not mutate the read', () => {
    const input = [{ date: '2026-10-01', text: 'a' }, { date: '2026-10-02', text: 'b' }];
    reflectionsNewestFirst(input);
    expect(input).toEqual([{ date: '2026-10-01', text: 'a' }, { date: '2026-10-02', text: 'b' }]);
  });
});

describe('reflectionOrdinals', () => {
  it('numbers same-date entries 1, 2, 3 in note order, and every entry of another date starts again', () => {
    const a = { date: '2026-10-02', text: 'a' };
    const b = { date: '2026-10-05', text: 'b' };
    const c = { date: '2026-10-05', text: 'c' };
    const d = { date: '2026-10-05', text: 'd' };
    const e = { date: '2026-10-09', text: 'e' };
    expect(reflectionOrdinals([a, b, c, d, e])).toEqual([1, 1, 2, 3, 1]);
  });
  it('keeps the note order even when the list is shown newest first', () => {
    const second = { date: '2026-10-05', text: 'second' };
    const third = { date: '2026-10-05', text: 'third' };
    const first = { date: '2026-10-02', text: 'first' };
    const shown = reflectionsNewestFirst([first, second, third]);
    expect(shown).toEqual([second, third, first]);
    // The two 2026-10-05 entries keep their note order, so their ordinals are 1 then 2, not reversed.
    expect(reflectionOrdinals(shown)).toEqual([1, 2, 1]);
  });
});

describe('Actions labels', () => {
  it('names every reading action, including the reflection pair', () => {
    expect(VERB.SaveReflection).toBe('Reflection');
    expect(VERB.UndoSaveReflection).toBe('Undo reflection');
    expect(VERB.StartBook).toBe('Start book');
    expect(VERB.LogReading).toBe('Log reading');
  });
});
