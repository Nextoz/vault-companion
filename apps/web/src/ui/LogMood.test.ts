import type { Command } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moodCheckin, undoMoodCheckinDraft } from '../commands.ts';
import type { QueueItem } from '../queue/queue.ts';
import { MOOD_HISTORY_LIMIT, MoodHistory, recentCheckins } from './LogMood.tsx';

const ACCOUNT = 'a'.repeat(64);
const ctx = { baseRevision: '1'.repeat(40) };

function queued(envelope: Command, seq: number): QueueItem {
  return {
    operationId: envelope.operationId,
    seq,
    type: envelope.type,
    envelope,
    label: 'Mood',
    taskKey: 'mood',
    accountKey: ACCOUNT,
    state: 'pending',
    error: null,
    everSent: false,
    accountMismatch: false,
    receipt: null,
    acknowledged: false,
  };
}

const checkin = (date: string, at: string, mood = 1, energy = -2, sleep = 7.5) =>
  moodCheckin(ctx, { date, mood, energy, sleep, checkinAt: at });

describe('recent check-ins (UX5)', () => {
  it('keeps the newest first regardless of queue order', () => {
    const older = checkin('2026-10-01', '2026-10-01T07:00:00.000Z');
    const newer = checkin('2026-10-02', '2026-10-02T06:14:00.000Z');
    const entries = recentCheckins([queued(newer, 3), queued(older, 1)]);
    expect(entries.map((e) => e.payload.date)).toEqual(['2026-10-02', '2026-10-01']);
  });

  it('caps the list at the limit', () => {
    const items = Array.from({ length: MOOD_HISTORY_LIMIT + 3 }, (_, i) =>
      queued(checkin('2026-10-01', `2026-10-01T${String(i).padStart(2, '0')}:00:00.000Z`), i + 1));
    expect(recentCheckins(items)).toHaveLength(MOOD_HISTORY_LIMIT);
  });

  it('drops a check-in an Undo already targets and ignores other commands', () => {
    const target = checkin('2026-10-02', '2026-10-02T06:14:00.000Z');
    const undo = undoMoodCheckinDraft(ctx, target);
    expect(recentCheckins([queued(target, 1), queued(undo, 2)])).toEqual([]);
  });
});

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  dom.window.close();
});

const render = async (items: readonly QueueItem[]) => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(MoodHistory, { items })); });
};

describe('Mood history view (UX5)', () => {
  it('shows date, mood, energy and sleep newest first', async () => {
    const items = [
      queued(checkin('2026-10-02', '2026-10-02T06:14:00.000Z', 2, 1, 8), 2),
      queued(checkin('2026-10-01', '2026-10-01T06:14:00.000Z', -3, 0, 6.5), 1),
    ];
    await render(items);
    const rows = [...document.querySelectorAll('.log-mood-row')].map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Fri 2 Oct');
    expect(rows[0]).toContain('Mood +2');
    expect(rows[0]).toContain('Energy +1');
    expect(rows[0]).toContain('Sleep 8 h');
    expect(rows[1]).toContain('Mood \u22123');
    expect(rows[1]).toContain('Sleep 6.5 h');
  });

  it('says so when the device holds no check-ins', async () => {
    await render([]);
    expect(document.querySelector('.log-mood-row')).toBeNull();
    expect(document.querySelector('[aria-label="Mood"]')!.textContent).toContain('No check-ins on this device yet.');
  });
});
