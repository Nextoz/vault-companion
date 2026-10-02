import { describe, expect, it } from 'vitest';
import type { Fetched } from './api.ts';
import { combineViews, createLastCopies, openView, settleView } from './lastCopy.ts';

const ok = (data: string): Fetched<string> => ({ kind: 'ok', data });

describe('last copies (SP3, ADR-0038)', () => {
  it('keeps one copy per account and key; no account means no copy', () => {
    const copies = createLastCopies();
    copies.put('a', 'notes', 'A', 1);
    copies.put(null, 'notes', 'nobody', 1);
    expect(copies.get('a', 'notes')).toEqual({ data: 'A', at: 1 });
    expect(copies.get('b', 'notes')).toBeNull();
    expect(copies.get(null, 'notes')).toBeNull();
  });

  it('drops the least recently written copy beyond the limit', () => {
    const copies = createLastCopies(2);
    copies.put('a', 'x', 1, 1);
    copies.put('a', 'y', 2, 2);
    copies.put('a', 'x', 3, 3);
    copies.put('a', 'z', 4, 4);
    expect(copies.get('a', 'y')).toBeNull();
    expect(copies.get('a', 'x')?.data).toBe(3);
    expect(copies.get('a', 'z')?.data).toBe(4);
  });

  it('opens from the copy, marked with its time, and shows nothing without one', () => {
    const copies = createLastCopies();
    expect(openView(copies, 'a', 'notes')).toEqual({ res: null, copyAt: null, refreshing: true, failed: false });
    copies.put('a', 'notes', 'old', 5);
    expect(openView(copies, 'a', 'notes')).toEqual({ res: ok('old'), copyAt: 5, refreshing: true, failed: false });
  });

  it('a fresh answer replaces the copy and is no longer marked as one', () => {
    const copies = createLastCopies();
    copies.put('a', 'notes', 'old', 5);
    const view = settleView(copies, 'a', 'notes', openView<string>(copies, 'a', 'notes'), ok('new'), 9);
    expect(view).toEqual({ res: ok('new'), copyAt: null, refreshing: false, failed: false });
    expect(copies.get('a', 'notes')).toEqual({ data: 'new', at: 9 });
  });

  it('a failed refresh keeps the copy but says so, with the copy time', () => {
    const copies = createLastCopies();
    copies.put('a', 'notes', 'old', 5);
    const failed = settleView(copies, 'a', 'notes', openView<string>(copies, 'a', 'notes'), { kind: 'offline' }, 9);
    expect(failed).toEqual({ res: ok('old'), copyAt: 5, refreshing: false, failed: true });
    // A screen showing this session's fresh read, whose next refresh fails, is marked from that read's time.
    const fresh = settleView(copies, 'a', 'notes', failed, ok('new'), 12);
    expect(settleView(copies, 'a', 'notes', fresh, { kind: 'error', message: 'x' }, 20))
      .toEqual({ res: ok('new'), copyAt: 12, refreshing: false, failed: true });
  });

  it('a failure without a copy is shown as the failure', () => {
    const copies = createLastCopies();
    const view = settleView(copies, 'a', 'notes', openView<string>(copies, 'a', 'notes'), { kind: 'offline' }, 9);
    expect(view.res).toEqual({ kind: 'offline' });
    expect(view.copyAt).toBeNull();
  });

  it('signed out drops every copy of every account and never shows the copy', () => {
    const copies = createLastCopies();
    copies.put('a', 'notes', 'old', 5);
    copies.put('b', 'training', 'other', 5);
    const view = settleView(copies, 'a', 'notes', openView<string>(copies, 'a', 'notes'), { kind: 'signed-out' }, 9);
    expect(view.res).toEqual({ kind: 'signed-out' });
    expect(view.copyAt).toBeNull();
    expect(copies.get('a', 'notes')).toBeNull();
    expect(copies.get('b', 'training')).toBeNull();
  });

  it('a screen of several reads names its oldest copy, and any failed copy', () => {
    const fresh = { res: ok('x'), copyAt: null, refreshing: false, failed: false };
    const copy = (at: number, failed = false) => ({ res: ok('c'), copyAt: at, refreshing: !failed, failed });
    expect(combineViews([fresh, fresh]).copyAt).toBeNull();
    expect(combineViews([fresh, copy(9), copy(5)])).toEqual({ res: null, copyAt: 5, refreshing: true, failed: false });
    expect(combineViews([copy(9), copy(5, true)])).toMatchObject({ copyAt: 5, failed: true });
  });
});
