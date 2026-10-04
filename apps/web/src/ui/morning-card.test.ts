import { MorningBriefMissingResponse, MorningBriefResponse, RadarResponse, ScoutsResponse, WeatherResponse, type Command, type RadarPaper, type WeatherProjection, type WeatherRunWindow } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { moodCheckin, undoMoodCheckinDraft } from '../commands.ts';
import type { QueueItem } from '../queue/queue.ts';
import { briefLines, checkinDue, missingBriefText, morningBriefSheet, morningLines, radarHighlights, researchHighlightsText, runWindowGlance, tasksTodayText, weatherDayGlance, weatherLine, type MorningCardFacts } from './morning-card.ts';
import type { NeedsYouRow } from './needs-you.ts';

const ACCOUNT = 'a'.repeat(64);
const ctx = { baseRevision: '1'.repeat(40) };
const SHA = 'a'.repeat(40);

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

type WeatherPoint = WeatherProjection['models'][number]['points'][number];

/** One sunny/rainy projection point at a Copenhagen daytime hour (October = UTC+2). */
const at = (localHour: number, over: Partial<WeatherPoint> = {}): WeatherPoint => ({
  time: `2026-10-02T${String(localHour - 2).padStart(2, '0')}:00:00Z`, temperatureC: 12, rainMm: 0, windMs: 2, ...over,
});

const DAY_PROJECTION = (points: readonly WeatherPoint[], runWindow: WeatherRunWindow | null = null): WeatherProjection => ({
  location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
  now: '2026-10-02T10:00:00Z',
  models: [{ model: 'dmi_harmonie_arome_europe', label: 'DMI HARMONIE AROME Europe', resolutionKm: 2,
    sourceUrl: 'https://example.test/dmi', retrievedAt: '2026-10-02T09:00:00Z', expectedPoints: 48, points: [...points], missingIntervals: 0 }],
  agreement: 'single-model',
  coverage: { expectedPoints: 48, primaryReturned: points.length, comparisonReturned: 0, primaryMissingIntervals: 0, comparisonMissingIntervals: 0 },
  runWindow, partialError: 'none', attribution: 'Synthetic forecast.', termsUrl: 'https://example.test/terms',
});

const runWindow = (over: Partial<WeatherRunWindow> = {}): WeatherRunWindow => ({
  day: '2026-10-02', daytimeStart: '08:00', daytimeEnd: '20:00',
  start: '2026-10-02T06:00:00Z', end: '2026-10-02T08:00:00Z', agreement: 'two-models',
  models: ['dmi_harmonie_arome_europe'], rainMm: 0, rainRangeMm: { min: 0, max: 0 },
  temperatureRangeC: { min: 12, max: 14 }, windRangeMs: { min: 1, max: 2 }, note: 'Synthetic lowest-rain window.', ...over,
});

const weatherOk = (points: readonly WeatherPoint[] = [at(8, { temperatureC: 12 }), at(12, { temperatureC: 14 }), at(16, { temperatureC: 13 })]): WeatherResponse =>
  WeatherResponse.parse({ status: 'ok', projection: DAY_PROJECTION(points, runWindow()) });

const scoutStatus = (runStatus: 'success' | 'failed') => ({
  schemaVersion: 1 as const, scoutId: 'city-events', displayName: 'City events', schedule: null, expectedEveryHours: 24,
  lastAttemptAt: '2026-10-02T06:00:00Z', lastSuccessAt: runStatus === 'success' ? '2026-10-02T06:00:00Z' : null,
  runStatus, sources: null, aiHealth: null, findings: 1, added: null, errors: null, lastError: null, latestOutput: null, history: [],
});
const scoutsWith = (runStatus: 'success' | 'failed'): ScoutsResponse =>
  ScoutsResponse.parse({ revision: SHA, now: '2026-10-02T10:00:00Z', scouts: [{ state: 'ok', file: 'city.json', status: scoutStatus(runStatus) }] });

const radarPaper = (n: number): RadarPaper => ({
  paperId: n.toString(16).padStart(20, '0'), rank: n, title: `Paper ${n}`, why: '', topic: 'systems',
  sourceUrl: `https://example.test/paper-${n}`, sourceDate: '2026-10-01', badges: [], read: { kind: 'source', url: `https://example.test/paper-${n}` },
});
const radarDecision = (paperId: string, decision: 'keep' | 'remove'): RadarResponse['decisions'][number] => ({
  schemaVersion: 1, decisionId: decision === 'remove' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
  paperId, decision, undoes: null, at: '2026-10-02T09:00:00Z', month: '2026-10',
  card: { title: 'Paper', source: 'https://example.test/paper-1', topic: 'systems' },
});
const radarWith = (papers: readonly RadarPaper[], decisions: RadarResponse['decisions'] = []): RadarResponse => RadarResponse.parse({
  revision: SHA, now: '2026-10-02T10:00:00Z',
  sources: { dailyScout: { state: 'ok', count: papers.length }, readingBriefs: { state: 'absent', count: 0 },
    importantUpdates: { state: 'absent', count: 0 }, explained: { state: 'absent', count: 0 } },
  papers: [...papers], topics: [], decisions: [...decisions], applied: {}, appliedUpdatedAt: null, warnings: [],
});

const empty: MorningCardFacts = { weather: null, weatherFailed: false, scouts: null, eventsToTriage: 0, tasksToday: 0, researchHighlights: null, needs: [] };

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

  it('renders the plain weather day line plus the run window from an ok projection', () => {
    const [weather, ...rest] = morningLines({ ...empty, weather: weatherOk() });
    expect(weather!.id).toBe('weather');
    expect(weather!.text).toBe('Dry · 14° · Run window 08-10, dry');
    expect(rest).toEqual([{ id: 'tasks', text: 'No tasks today' }]);
  });

  it('counts only scouts with problems and pluralises the line', () => {
    expect(morningLines({ ...empty, scouts: scoutsWith('failed') })[0]).toEqual({ id: 'scouts', text: '1 scout needs attention' });
  });

  it('renders one research entry from the Radar highlights', () => {
    expect(morningLines({ ...empty, researchHighlights: 3 })[0]).toEqual({ id: 'research', text: 'Research · 3 highlights' });
    expect(morningLines({ ...empty, researchHighlights: 0 })[0]).toEqual({ id: 'research', text: 'No research highlights' });
  });

  it('renders an events line only when events wait and keeps the order', () => {
    expect(morningLines({ ...empty, eventsToTriage: 1 })[0]).toEqual({ id: 'triage', text: '1 new event' });
    expect(morningLines({ weather: weatherOk(), weatherFailed: false, scouts: scoutsWith('failed'), researchHighlights: 3, eventsToTriage: 3, tasksToday: 2, needs: [] }))
      .toEqual([{ id: 'weather', text: 'Dry · 14° · Run window 08-10, dry' }, { id: 'scouts', text: '1 scout needs attention' },
        { id: 'research', text: 'Research · 3 highlights' }, { id: 'triage', text: '3 new events' },
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

describe('weather wording (UX7)', () => {
  it('reads the day in plain language: rain, warmth and only wind that matters', () => {
    expect(weatherDayGlance(DAY_PROJECTION([at(8, { rainMm: 0.4, temperatureC: 11, windMs: 5 }), at(12, { rainMm: 0.6, temperatureC: 10, windMs: 4 })])))
      .toBe('Rain all day · 11° · breezy');
    expect(weatherDayGlance(DAY_PROJECTION([at(8, { rainMm: 0, temperatureC: 12 }), at(12, { rainMm: 0, temperatureC: 14 })])))
      .toBe('Dry · 14°');
  });

  it('says "Showers" for a mixed day and is honest when the forecast has no daytime points', () => {
    expect(weatherDayGlance(DAY_PROJECTION([at(8, { rainMm: 0 }), at(12, { rainMm: 0.5 })]))).toBe('Showers · 12°');
    expect(weatherDayGlance(DAY_PROJECTION([]))).toBe('Rain unknown');
  });

  it('gives the run window its own wording, only when one exists', () => {
    expect(runWindowGlance(runWindow({ rainMm: 0 }))).toBe('Run window 08-10, dry');
    expect(runWindowGlance(runWindow({ rainMm: 0.3 }))).toBe('Run window 08-10, wet');
    expect(runWindowGlance(runWindow({ rainMm: null }))).toBe('Run window 08-10, rain unknown');
    expect(runWindowGlance(null)).toBeNull();
  });

  it('appends the window to the day line and never says "No daytime window"', () => {
    const day = DAY_PROJECTION([at(8, { temperatureC: 14 })], runWindow());
    expect(weatherLine(day)).toBe('Dry · 14° · Run window 08-10, dry');
    expect(weatherLine({ ...day, runWindow: null })).toBe('Dry · 14°');
    expect(weatherLine({ ...day, runWindow: null })).not.toContain('No daytime window');
  });
});

describe('Radar highlights (UX7)', () => {
  it('counts the papers left after Remove and Keep, and words the one entry', () => {
    const papers = [radarPaper(1), radarPaper(2), radarPaper(3)];
    expect(radarHighlights(radarWith(papers))).toBe(3);
    expect(radarHighlights(radarWith(papers, [radarDecision(papers[0]!.paperId, 'remove')]))).toBe(2);
    expect(researchHighlightsText(0)).toBe('No research highlights');
    expect(researchHighlightsText(1)).toBe('Research · 1 highlight');
    expect(researchHighlightsText(3)).toBe('Research · 3 highlights');
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

describe('Morning Brief sheet state (UX7)', () => {
  const sample = (o: { date?: string; brief?: Partial<MorningBriefResponse['brief']> } = {}) =>
    MorningBriefResponse.parse({
      revision: 'a'.repeat(40), date: o.date ?? '2026-10-02', generatedAt: '2026-10-02T04:31:00+02:00',
      source: 'model', unavailable: [], brief: { source: 'model', dayLine: 'A calm Thursday.', gaps: [], todos: [], ...o.brief },
    });

  it('returns the brief rows and no reason for a usable brief today', () => {
    const state = morningBriefSheet(sample({ brief: { stateLine: 'Low energy.', todos: [
      { id: 1, text: 'Pay the bill', due: null, bill: false },
    ] } }), '2026-10-02');
    expect(state.missing).toBeNull();
    expect(state.lines.map((line) => line.text)).toEqual(['A calm Thursday.', 'Low energy.', 'Pay the bill']);
  });

  it('returns "No brief yet" plus the job reason for a missing file', () => {
    const missing = MorningBriefMissingResponse.parse({ kind: 'missing', revision: 'a'.repeat(40), statusError: 'not-written:precondition-failed' });
    expect(morningBriefSheet(missing, '2026-10-02')).toEqual({ missing: 'No brief yet - not-written:precondition-failed', lines: [] });
    const noReason = MorningBriefMissingResponse.parse({ kind: 'missing', revision: 'a'.repeat(40), statusError: null });
    expect(morningBriefSheet(noReason, '2026-10-02')).toEqual({ missing: 'No brief yet', lines: [] });
  });

  it('returns a plain "No brief yet" when the read failed or the only file is stale', () => {
    expect(morningBriefSheet(null, '2026-10-02')).toEqual({ missing: 'No brief yet', lines: [] });
    expect(morningBriefSheet(sample({ date: '2026-10-01' }), '2026-10-02')).toEqual({ missing: 'No brief yet', lines: [] });
  });
});
