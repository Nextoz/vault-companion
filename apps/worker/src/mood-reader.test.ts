// Server-side Daily-note mood reader: synthetic vault bytes only, no note text outside the test assertions.
import { describe, expect, it } from 'vitest';
import { StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { createMoodReader } from './mood-reader.ts';

const TODAY = '2026-10-04';
const YESTERDAY = '2026-10-03';

const dailyNote = (date: string, mood: number, energy: number, sleep: number, checkinAt: string): string =>
  ['---', `date: ${date}`, `mood: ${mood}`, `energy: ${energy}`, `sleep: ${sleep}`, `checkin_at: ${checkinAt}`, '---', '', 'Body text', ''].join('\n');

describe('createMoodReader', () => {
  it('reads today and yesterday into the payload shape the gatherer expects', async () => {
    const store = await InMemoryStore.create({
      [`Journal/Daily/${TODAY}.md`]: dailyNote(TODAY, -1, 2, 7.5, '2026-10-04T06:14:00.000Z'),
      [`Journal/Daily/${YESTERDAY}.md`]: dailyNote(YESTERDAY, 3, -3, 0.5, '2026-10-03T22:30:00.000Z'),
    });
    const result = await createMoodReader({ store }).readMood(TODAY);
    expect(result).toEqual([
      { date: TODAY, mood: -1, energy: 2, sleep: 7.5, checkinAt: '2026-10-04T06:14:00.000Z' },
      { date: YESTERDAY, mood: 3, energy: -3, sleep: 0.5, checkinAt: '2026-10-03T22:30:00.000Z' },
    ]);
  });

  it('missing or blank Daily notes are an empty list, not unavailable', async () => {
    const blank = await InMemoryStore.create({ [`Journal/Daily/${TODAY}.md`]: '---\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n' });
    expect(await createMoodReader({ store: blank }).readMood(TODAY)).toEqual([]);

    const missing = await InMemoryStore.create({});
    expect(await createMoodReader({ store: missing }).readMood(TODAY)).toEqual([]);
  });

  it('uses yesterday when today has no check-in yet (stale but valid)', async () => {
    const store = await InMemoryStore.create({
      [`Journal/Daily/${TODAY}.md`]: '---\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n',
      [`Journal/Daily/${YESTERDAY}.md`]: dailyNote(YESTERDAY, 2, -1, 8, '2026-10-03T21:30:00.000Z'),
    });
    expect(await createMoodReader({ store }).readMood(TODAY)).toEqual([
      { date: YESTERDAY, mood: 2, energy: -1, sleep: 8, checkinAt: '2026-10-03T21:30:00.000Z' },
    ]);
  });

  it('crosses month boundaries with the calendar-date previous day', async () => {
    const store = await InMemoryStore.create({
      'Journal/Daily/2026-03-01.md': dailyNote('2026-03-01', 0, 0, 7, '2026-03-01T06:14:00.000Z'),
      'Journal/Daily/2026-02-28.md': dailyNote('2026-02-28', -1, 1, 6, '2026-02-28T22:30:00.000Z'),
    });
    const result = await createMoodReader({ store }).readMood('2026-03-01');
    if (!Array.isArray(result)) throw new Error('expected check-ins');
    expect(result).toHaveLength(2);
    expect(result[0]?.date).toBe('2026-03-01');
    expect(result[1]?.date).toBe('2026-02-28');
  });

  it('a vault read failure is an ApiError with a fixed code, not a throw', async () => {
    const store = await InMemoryStore.create({});
    store.readFile = async () => { throw new StoreUnavailable('synthetic outage'); };
    expect(await createMoodReader({ store }).readMood(TODAY)).toEqual({
      code: 'upstream-unavailable',
      message: 'Vault is not reachable right now',
      retryable: true,
    });
  });

  it('an invalid UTF-8 Daily note is refused with the fixed encoding code', async () => {
    const store = await InMemoryStore.create({ [`Journal/Daily/${TODAY}.md`]: new Uint8Array([0x66, 0x66, 0xff]) });
    expect(await createMoodReader({ store }).readMood(TODAY)).toEqual({
      code: 'refused:encoding',
      message: 'Daily journal is not valid UTF-8',
      retryable: false,
    });
  });

  it('uses the pinned head and makes exactly two blob reads', async () => {
    const store = await InMemoryStore.create({
      [`Journal/Daily/${TODAY}.md`]: dailyNote(TODAY, 1, 1, 7, '2026-10-04T06:14:00.000Z'),
      [`Journal/Daily/${YESTERDAY}.md`]: dailyNote(YESTERDAY, 0, 0, 8, '2026-10-03T22:30:00.000Z'),
    });
    const before = store.headCommit;
    await createMoodReader({ store }).readMood(TODAY);
    expect(store.headCommit).toBe(before);
    expect(store.calls.filter((call) => call === 'readFile')).toHaveLength(2);
  });
});
