import { describe, expect, it } from 'vitest';
import { moreTasksText, selectNextUp, tileHue, todayTiles, todaysUpcomingEvents, type TodayTileFacts } from './today.ts';

// 2026-09-30 is a Wednesday; these instants all sit in the Copenhagen day.
const TODAY = '2026-09-30';
const NOW = '2026-09-30T12:00:00+02:00';

const event = (eventId: string, title: string, start: string) => ({ eventId, title, start });

describe('todaysUpcomingEvents', () => {
  it('keeps only today, not-yet-started events, soonest first', () => {
    const events = [
      event('c', 'Later', `${TODAY}T18:00:00+02:00`),
      event('a', 'Early', `${TODAY}T13:00:00+02:00`),
      event('past', 'Gone', `${TODAY}T09:00:00+02:00`),
      event('tomorrow', 'Tomorrow', '2026-10-01T09:00:00+02:00'),
    ];
    expect(todaysUpcomingEvents(events, TODAY, NOW).map((e) => e.eventId)).toEqual(['a', 'c']);
  });

  it('drops an unreadable start rather than guessing', () => {
    const events = [event('bad', 'Broken', 'not-a-date')];
    expect(todaysUpcomingEvents(events, TODAY, NOW)).toEqual([]);
  });
});

describe('selectNextUp', () => {
  const tasks = [{ id: 't1' }, { id: 't2' }];

  it('prefers the next calendar commitment today over a task', () => {
    const pick = selectNextUp([event('e1', 'Standup', `${TODAY}T13:00:00+02:00`)], tasks, TODAY, NOW);
    expect(pick).toEqual({ kind: 'event', event: { eventId: 'e1', title: 'Standup', start: `${TODAY}T13:00:00+02:00` } });
  });

  it('falls back to the first of today’s tasks when no commitment is left', () => {
    const pick = selectNextUp([event('past', 'Gone', `${TODAY}T09:00:00+02:00`)], tasks, TODAY, NOW);
    expect(pick).toEqual({ kind: 'task', task: { id: 't1' } });
  });

  it('is a quiet empty state with nothing planned', () => {
    expect(selectNextUp([], [], TODAY, NOW)).toEqual({ kind: 'none' });
  });
});

describe('moreTasksText', () => {
  it('never invents a count', () => {
    expect(moreTasksText(0)).toBe('No more tasks today');
    expect(moreTasksText(1)).toBe('1 more task today');
    expect(moreTasksText(3)).toBe('3 more tasks today');
  });
});

describe('todayTiles (R3b: the label carries the noun, the body the fact)', () => {
  const facts: TodayTileFacts = { brief: 'A calm synthetic day.', needs: 2, weather: 'Dry · 17°', research: 2 };

  it('returns the four tiles in a fixed order', () => {
    expect(todayTiles(facts).map((tile) => tile.id)).toEqual(['brief', 'needs', 'weather', 'research']);
    expect(todayTiles(facts)[0]).toMatchObject({ label: 'Morning Brief', stat: null, body: facts.brief, name: 'Morning Brief' });
  });

  it('never repeats the noun in the body: Needs you · 2 becomes "2" + "items"', () => {
    const [, needs, weather, research] = todayTiles(facts);
    expect(needs).toMatchObject({ label: 'Needs you', stat: '2', body: 'items', name: 'Needs you · 2 items' });
    expect(research).toMatchObject({ label: 'Research', stat: '2', body: 'highlights', name: 'Research · 2 highlights' });
    expect(weather).toMatchObject({ label: 'Weather', stat: null, body: 'Dry · 17°', name: 'Weather · Dry · 17°' });
    for (const tile of todayTiles(facts)) if (tile.id !== 'brief') expect(tile.body).not.toContain(tile.label);
  });

  it('uses the singular for one and words a zero research count', () => {
    const tiles = todayTiles({ ...facts, needs: 1, research: 1 });
    expect(tiles[1]).toMatchObject({ stat: '1', body: 'item', name: 'Needs you · 1 item' });
    expect(tiles[3]).toMatchObject({ stat: '1', body: 'highlight' });
    expect(todayTiles({ ...facts, research: 0 })[3]).toMatchObject({ stat: null, body: 'No highlights', name: 'Research · No highlights' });
  });

  it('drops a source with nothing to say but keeps the brief tile', () => {
    expect(todayTiles({ ...facts, needs: null, research: null }).map((tile) => tile.id)).toEqual(['brief', 'weather']);
    expect(todayTiles({ ...facts, needs: 0 }).map((tile) => tile.id)).toEqual(['brief', 'weather', 'research']);
  });
});

describe('tile hue', () => {
  it('gives each tile its domain token and an unknown id the neutral separator', () => {
    expect(['brief', 'needs', 'weather', 'research'].map(tileHue))
      .toEqual(['var(--hue-events)', 'var(--hue-tasks)', 'var(--hue-weather)', 'var(--hue-research)']);
    expect(tileHue('future')).toBe('var(--line)');
  });
});
