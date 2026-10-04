import { MorningBriefResponse, MorningResponse, ScoutsResponse, WeatherResponse, type Command, type WeatherRunWindow } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { moodCheckin, undoMoodCheckinDraft } from '../commands.ts';
import type { QueueItem } from '../queue/queue.ts';
import { briefLines, checkinDue, missingBriefText, morningLines, tasksTodayText, weatherGlance, type MorningCardFacts } from './morning-card.ts';
import type { NeedsYouRow } from './needs-you.ts';

const ACCOUNT = 'a'.repeat(64);
const ctx = { baseRevision: '1'.repeat(40) };
const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);

function queued(envelope: Command, seq: number): QueueItem {
  return {
    operationId: envelope.operationId,
    seq,
    type: envelope.type,
    envelope,
    label: envelope.type,
    taskKey: null,
    accountKey: ACCOUNT,
    state: 'pending',
    error: null,
    everSent: false,
    accountMismatch: false,
    receipt: null,
    acknowledged: false,
  };
}

const checkin = (date: string) =>
  moodCheckin(ctx, { date, mood: 1, energy: -2, sleep: 7.5, checkinAt: `${date}T06:14:00.000Z` });

const weatherOk = (): WeatherResponse => WeatherResponse.parse({
  status: 'ok',
  projection: {
    location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
    now: '2026-10-02T10:00:00Z',
    models: [{ model: 'dmi_harmonie_arome_europe', label: 'DMI HARMONIE AROME Europe', resolutionKm: 2,
      sourceUrl: 'https://example.test/dmi', retrievedAt: '2026-10-02T09:00:00Z', expectedPoints: 48, points: [], missingIntervals: 48 }],
    agreement: 'single-model',
    coverage: { expectedPoints: 48, primaryReturned: 0, comparisonReturned: 0, primaryMissingIntervals: 48, comparisonMissingIntervals: 0 },
    runWindow: { day: '2026-10-02', daytimeStart: '08:00', daytimeEnd: '20:00', start: '2026-10-02T10:00:00Z', end: '2026-10-02T12:00:00Z',
      agreement: 'single-model', models: ['dmi_harmonie_arome_europe'], rainMm: 0.3, rainRangeMm: { min: 0.3, max: 0.4 },
      temperatureRangeC: { min: 12, max: 14 }, windRangeMs: { min: 2, max: 3 }, note: 'Synthetic lowest-rain window.' },
    partialError: 'none',
    attribution: 'Synthetic forecast.', termsUrl: 'https://example.test/terms',
  },
});

const scoutStatus = (runStatus: 'success' | 'failed') => ({
  schemaVersion: 1 as const, scoutId: 'city-events', displayName: 'City events', schedule: null, expectedEveryHours: 24,
  lastAttemptAt: '2026-10-02T06:00:00Z', lastSuccessAt: runStatus === 'success' ? '2026-10-02T06:00:00Z' : null,
  runStatus, sources: null, aiHealth: null, findings: 1, added: null, errors: null, lastError: null, latestOutput: null, history: [],
});
const scoutsWith = (runStatus: 'success' | 'failed'): ScoutsResponse =>
  ScoutsResponse.parse({ revision: SHA, now: '2026-10-02T10:00:00Z', scouts: [{ state: 'ok', file: 'city.json', status: scoutStatus(runStatus) }] });

const note = (status: string, title: string) =>
  ({ status: 'ok' as const, revision: SHA, path: `Research/${title}.md`, blobSha: BLOB,
    markdown: `---\ntype: research-explained\nstatus: ${status}\n---\n\n# ${title}\n\nBody\n` });
const morningWith = (brief: boolean, explained: number): MorningResponse =>
  MorningResponse.parse({ revision: SHA, date: '2026-10-02', brief: brief ? note('complete', 'Brief') : null,
    explained: Array.from({ length: explained }, (_, i) => note(i === 0 ? 'complete' : 'pending', `Paper ${i}`)) });

const empty: MorningCardFacts = { weather: null, weatherFailed: false, scouts: null, morning: null, eventsToTriage: 0, tasksToday: 0, needs: [] };

describe('morning card lines', () => {
  it('omits lines with nothing to say and always keeps the tasks line', () => {
    expect(morningLines(empty)).toEqual([{ id: 'tasks', text: 'No tasks today' }]);
    expect(morningLines({ ...empty, scouts: scoutsWith('success') })).toEqual([{ id: 'tasks', text: 'No tasks today' }]);
  });

  it('keeps an honestly unavailable weather line instead of a placeholder', () => {
    const unavailable = WeatherResponse.parse({ status: 'unavailable', now: '2026-10-02T10:00:00Z',
      location: { label: 'x', latitude: 1, longitude: 1, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
      reason: 'no-data', message: 'No weather model returned usable forecast points.' });
    expect(morningLines({ ...empty, weather: unavailable })).toEqual([
      { id: 'weather', text: 'No weather model returned usable forecast points.' },
      { id: 'tasks', text: 'No tasks today' },
    ]);
  });

  it('keeps a detail entry point when the weather read itself failed', () => {
    expect(morningLines({ ...empty, weatherFailed: true })).toEqual([
      { id: 'weather', text: 'Weather unavailable' },
      { id: 'tasks', text: 'No tasks today' },
    ]);
  });

  it('renders the weather glance from an ok projection', () => {
    const [weather, ...rest] = morningLines({ ...empty, weather: weatherOk() });
    expect(weather!.id).toBe('weather');
    expect(weather!.text).toBe('Wet 10–12 · 14° · light wind');
    expect(rest).toEqual([{ id: 'tasks', text: 'No tasks today' }]);
  });

  it('counts only scouts with problems and pluralises the line', () => {
    expect(morningLines({ ...empty, scouts: scoutsWith('failed') })[0]).toEqual({ id: 'scouts', text: '1 scout needs attention' });
  });

  it('summarises the papers from the morning read', () => {
    const [papers] = morningLines({ ...empty, morning: morningWith(true, 2) });
    expect(papers).toEqual({ id: 'papers', text: 'Reading brief \u00b7 1 explained \u00b7 1 pending' });
  });

  it('renders an events line only when events wait and keeps the order', () => {
    expect(morningLines({ ...empty, eventsToTriage: 1 })[0]).toEqual({ id: 'triage', text: '1 new event' });
    expect(morningLines({ weather: weatherOk(), weatherFailed: false, scouts: scoutsWith('failed'), morning: morningWith(true, 2), eventsToTriage: 3, tasksToday: 2, needs: [] }))
      .toEqual([{ id: 'weather', text: 'Wet 10–12 · 14° · light wind' }, { id: 'scouts', text: '1 scout needs attention' },
        { id: 'papers', text: 'Reading brief \u00b7 1 explained \u00b7 1 pending' }, { id: 'triage', text: '3 new events' },
        { id: 'tasks', text: '2 tasks today' }]);
  });

  it('leads with a Needs you line counting the rows, and hides it when nothing needs the owner', () => {
    const row: NeedsYouRow = { id: 'triage', title: 'Event triage', why: '1 event decision waiting', target: { kind: 'triage' } };
    expect(morningLines(empty)).toEqual([{ id: 'tasks', text: 'No tasks today' }]);
    expect(morningLines({ ...empty, needs: [row] })[0]).toEqual({ id: 'needs', text: 'Needs you \u00b7 1' });
  });

  it('words the tasks line for none, one and many', () => {
    expect(tasksTodayText(0)).toBe('No tasks today');
    expect(tasksTodayText(1)).toBe('1 task today');
    expect(tasksTodayText(4)).toBe('4 tasks today');
  });
});

describe('weather glance (UX4)', () => {
  const window = (over: Partial<WeatherRunWindow> = {}): WeatherRunWindow => {
    const weather = weatherOk();
    if (weather.status !== 'ok' || !weather.projection.runWindow) throw new Error('fixture missing its run window');
    return { ...weather.projection.runWindow, ...over };
  };

  it('reads a short line: condition, two-hour span, warmth and wind', () => {
    expect(weatherGlance(window({ rainMm: 0, rainRangeMm: { min: 0, max: 0 }, temperatureRangeC: { min: 13, max: 14 }, windRangeMs: { min: 1, max: 2 } })))
      .toBe('Dry 10–12 · 14° · light wind');
  });

  it('uses the warmest temperature and grades the wind from its top end', () => {
    expect(weatherGlance(window({ temperatureRangeC: { min: 3, max: 9.4 }, windRangeMs: { min: 4, max: 6 } })))
      .toBe('Wet 10–12 · 9° · breezy');
    expect(weatherGlance(window({ windRangeMs: { min: 8, max: 12 } }))).toBe('Wet 10–12 · 14° · strong wind');
  });

  it('keeps honest wording when rain is unknown or no window was chosen', () => {
    expect(weatherGlance(window({ rainMm: null }))).toBe('Rain unknown 10–12 · 14° · light wind');
    expect(weatherGlance(null)).toBe('No daytime window');
  });
});

describe('check-in line visibility', () => {
  it('shows before any check-in and hides once today holds one', () => {
    expect(checkinDue([], '2026-10-02')).toBe(true);
    expect(checkinDue([queued(checkin('2026-10-02'), 1)], '2026-10-02')).toBe(false);
  });
  it('stays visible for a check-in on another day, and after an undo', () => {
    expect(checkinDue([queued(checkin('2026-10-01'), 1)], '2026-10-02')).toBe(true);
    const target = checkin('2026-10-02');
    expect(checkinDue([queued(target, 1), queued(undoMoodCheckinDraft(ctx, target), 2)], '2026-10-02')).toBe(true);
  });
});

describe('Morning Brief rows (MB2)', () => {
  const sample = (o: { date?: string; source?: 'model' | 'fallback'; brief?: Partial<MorningBriefResponse['brief']> } = {}) => {
    const source = o.source ?? 'model';
    return MorningBriefResponse.parse({
      revision: 'a'.repeat(40),
      date: o.date ?? '2026-10-02',
      generatedAt: '2026-10-02T04:31:00+02:00',
      source,
      unavailable: [],
      brief: { source, dayLine: 'A calm Thursday.', gaps: [], todos: [], ...o.brief },
    });
  };

  it('is null without a brief, and for a stale date so the card keeps its own lines', () => {
    expect(briefLines(null, '2026-10-02')).toBeNull();
    expect(briefLines(sample({ date: '2026-10-01' }), '2026-10-02')).toBeNull();
  });

  it('words the missing-brief line from the status error code, with no free text invented', () => {
    expect(missingBriefText(null)).toBe('No brief yet');
    expect(missingBriefText('not-written:precondition-failed')).toBe('No brief yet - not-written:precondition-failed');
  });

  it('marks a fallback brief', () => {
    const lines = briefLines(sample({ source: 'fallback' }), '2026-10-02')!;
    expect(lines[0]).toEqual({ id: 'fallback', text: 'Fallback brief', marker: true, todo: false });
  });

  it('renders gaps in their ISO offset wall clock and omits a gap without a suggestion', () => {
    const lines = briefLines(sample({ brief: { gaps: [
      { blockIndex: 1, start: '2026-10-02T09:00:00+02:00', end: '2026-10-02T10:30:00+02:00', suggestion: 'Deep work' },
      { blockIndex: 2, start: '2026-10-02T11:00:00+02:00', end: '2026-10-02T11:20:00+02:00' },
    ] } }), '2026-10-02')!;
    expect(lines.map((l) => l.text)).toEqual(['A calm Thursday.', '09:00-10:30  Deep work']);
  });

  it('appends a todo first step and marks only todos as opening Tasks', () => {
    const lines = briefLines(sample({ brief: { stateLine: 'Low energy.', todos: [
      { id: 1, text: 'Pay the bill', due: '2026-10-02', bill: true, firstStep: 'Open the banking app' },
      { id: 2, text: 'Call the dentist', due: null, bill: false },
    ], encouragement: 'You have got this.' } }), '2026-10-02')!;
    expect(lines).toEqual([
      { id: 'day', text: 'A calm Thursday.', marker: false, todo: false },
      { id: 'state', text: 'Low energy.', marker: false, todo: false },
      { id: 'todo-1', text: 'Pay the bill - Open the banking app', marker: false, todo: true },
      { id: 'todo-2', text: 'Call the dentist', marker: false, todo: true },
      { id: 'encouragement', text: 'You have got this.', marker: false, todo: false },
    ]);
  });
});
