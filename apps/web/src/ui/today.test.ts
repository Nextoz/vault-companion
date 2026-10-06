import { describe, expect, it } from 'vitest';
import { moreTasksText, selectNextUp, todayTiles, todaysUpcomingEvents, type TodayTileFacts } from './today.ts';

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

describe('todayTiles', () => {
  const facts: TodayTileFacts = { brief: 'A calm synthetic day.', needs: 'Needs you · 2', weather: 'Dry · 17°', research: 'Research · 2 highlights' };

  it('returns the four tiles in a fixed order', () => {
    expect(todayTiles(facts).map((tile) => tile.id)).toEqual(['brief', 'needs', 'weather', 'research']);
    expect(todayTiles(facts)[0]).toMatchObject({ title: 'Morning Brief', text: facts.brief, label: 'Morning Brief' });
    expect(todayTiles(facts)[2]!.label).toBe(facts.weather);
  });

  it('drops a source with nothing to say but keeps the brief tile', () => {
    const ids = todayTiles({ ...facts, needs: null, research: null }).map((tile) => tile.id);
    expect(ids).toEqual(['brief', 'weather']);
  });

  it('is data-driven: an extra tile is one more entry, not a layout change', () => {
    const extra = [...todayTiles(facts), { id: 'later', title: 'Later', text: 'Added later', label: 'Added later' }];
    expect(extra.map((tile) => tile.id)).toEqual(['brief', 'needs', 'weather', 'research', 'later']);
  });
});
