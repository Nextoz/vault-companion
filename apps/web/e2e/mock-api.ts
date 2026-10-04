import { TrainingResponse, type TrainingRow } from '@vault-companion/contracts';
// In-page API mock for Playwright. Every response is parsed through the contract schema before it is served,
// so a mock that drifts from packages/contracts fails loudly instead of testing a fiction.
import {
  ActiveWorkResponse,
  AiBudgetResponse,
  AiUsageResponse,
  ApiError,
  Command,
  DASHBOARD_RANGE_PLAN,
  DashboardRange,
  DashboardResponse,
  HealthHistoryResponse,
  HealthResponse,
  MarketTickerResponse,
  decodeLinkedNoteHeader,
  decodeNoteHeader,
  HistoryResponse,
  type HistoryItem,
  LINKED_NOTE_HEADER,
  LinkedNoteResponse,
  type LinkedNoteRequest,
  NOTE_HEADER,
  NoteReadResponse,
  NotesResponse,
  Receipt,
  SessionResponse,
  MorningBriefResponse,
  MorningResponse,
  RADAR_PAPER_HEADER,
  RadarDecisionLine,
  RadarNoteResponse,
  RadarResponse,
  ResearchRadarDecideCommand,
  ScoutsResponse,
  TasksResponse,
  TriageResponse,
  WeatherResponse,
  type TaskView,
} from '@vault-companion/contracts';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { z } from 'zod';
import { copenhagenDay } from '../src/triage.ts';

export const ACCOUNT = 'a'.repeat(64);
const TODAY = '2026-09-24';

let counter = 0;
const sha = () => (++counter).toString(16).padStart(40, '0');

/** AB3b: ten synthetic daily usage rows, oldest first, ending on the Dashboard's own day. */
const USAGE_END = Date.parse('2026-09-30T00:00:00Z');
const usageRow = (index: number, over: Record<string, number> = {}) => ({
  date: new Date(USAGE_END - (9 - index) * 86_400_000).toISOString().slice(0, 10),
  calls: index + 1, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0, ...over,
});

/** B12: the eight cells that identify a session row; the mock matches an edit on all of them. */
const sameTrainingRow = (a: TrainingRow, b: TrainingRow): boolean =>
  a.date === b.date && a.time === b.time && a.type === b.type && a.distance === b.distance &&
  a.duration === b.duration && a.weight === b.weight && a.split === b.split && a.note === b.note;

/** CAL-b: the create body the Worker accepts, mirrored so a drifting client fails loudly. */
const CalendarCreateBody = z.strictObject({
  operationId: z.string().uuid(),
  itemKey: z.string().min(1).max(512),
  title: z.string().min(1).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  type: z.string(),
  notes: z.string().max(2000).optional(),
});

export function taskView(lineIndex: number, description: string, extra: Partial<TaskView> = {}): TaskView {
  return {
    locator: {
      path: 'Tasks/To-Do List.md',
      blobSha: '2'.repeat(40),
      lineIndex,
      lineText: `- [ ] ${description} 📅 ${TODAY}`,
      occurrencesAtRead: 1,
    },
    description,
    status: 'open',
    section: 'open',
    priority: null,
    due: TODAY,
    scheduled: null,
    start: null,
    created: null,
    done: null,
    recurring: false,
    readOnlyReason: null,
    links: [],
    ...extra,
  };
}

/** `hold`: the request stays in flight until `release()`, then is answered as `ok`. */
export type CommandMode = 'ok' | 'offline' | 'unavailable' | 'hold' | { refuse: ApiError };

/** How a read (`/api/session`, `/api/tasks`) is answered; `hang`: never, until the page gives up. */
export type ReadMode = 'ok' | 'error' | 'offline' | 'hang';

const lines = (...rows: string[]): string => `${rows.join(String.fromCharCode(10))}${String.fromCharCode(10)}`;

const weatherStart = Date.parse('2026-09-30T06:00:00Z') / 1000;
const weatherPoint = (hour: number, over: Record<string, unknown> = {}) => ({
  time: new Date((weatherStart + hour) * 1000).toISOString(),
  temperatureC: 14 + hour * 0.5,
  rainMm: 0.1 + hour * 0.1,
  windMs: 3 + hour * 0.4,
  ...over,
});

const healthSeries = (base: number, spread: number) => Array.from({ length: 30 }, (_, index) =>
  index === 12 ? null : base + ((index * 13) % 7) - 3 + Math.round(spread * Math.sin(index)));

/** Synthetic history rows (no real health text): ~400 days ending yesterday, with a few null gaps. */
const healthHistoryDays = () => Array.from({ length: 400 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 29) - (399 - index) * 86_400_000).toISOString().slice(0, 10);
  const gap = index % 97 === 0;
  return {
    date,
    steps: gap ? null : 9000 + (index % 7) * 150,
    headphone_min: gap ? null : 40 + (index % 5),
    first_move: 300 + (index % 60),
    last_move: 1250 + (index % 40),
  };
});

export const sampleWeather = (partial = false): WeatherResponse => WeatherResponse.parse({
  status: 'ok',
  projection: {
    location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
    now: '2026-09-30T12:00:00Z',
    models: [
      {
        model: 'dmi_harmonie_arome_europe', label: 'DMI HARMONIE AROME Europe', resolutionKm: 2,
        sourceUrl: 'https://open-meteo.com/en/docs/dmi-api', retrievedAt: '2026-09-30T11:55:00Z', expectedPoints: 48,
        points: [0, 1, 2, 3, 4, 5].map((hour) => weatherPoint(hour, { rainMm: 0.1 + hour * 0.1 })),
        missingIntervals: 42,
      },
      ...(partial ? [] : [{
        model: 'ecmwf_ifs', label: 'ECMWF IFS 9 km', resolutionKm: 9,
        sourceUrl: 'https://open-meteo.com/en/docs/ecmwf-api', retrievedAt: '2026-09-30T11:55:00Z', expectedPoints: 48,
        points: [0, 1, 2, 3, 4, 5].map((hour) => weatherPoint(hour, { rainMm: 0.2 + hour * 0.1 })),
        missingIntervals: 42,
      }]),
    ],
    agreement: partial ? 'single-model' : 'two-models',
    coverage: { expectedPoints: 48, primaryReturned: 6, comparisonReturned: partial ? 0 : 6, primaryMissingIntervals: 42, comparisonMissingIntervals: partial ? 0 : 42 },
    runWindow: {
      day: '2026-09-30', daytimeStart: '08:00', daytimeEnd: '20:00',
      start: '2026-09-30T06:00:00Z', end: '2026-09-30T08:00:00Z',
      agreement: partial ? 'single-model' : 'two-models',
      models: partial ? ['dmi_harmonie_arome_europe'] : ['dmi_harmonie_arome_europe', 'ecmwf_ifs'],
      rainMm: 0.3, rainRangeMm: partial ? { min: 0.3, max: 0.3 } : { min: 0.3, max: 0.5 },
      temperatureRangeC: { min: 14, max: 15 }, windRangeMs: { min: 3, max: 4 },
      note: 'Lowest-rain two-hour window inside Copenhagen daytime 08:00-20:00. Not a guarantee of dry or daylight weather.',
    },
    partialError: partial ? 'one-model-unavailable' : 'none',
    attribution: 'Forecast data by DMI and ECMWF via Open-Meteo, CC-BY 4.0.',
    termsUrl: 'https://open-meteo.com/en/terms',
  },
});

export class MockApi {
  // Public-market fixtures only; never contact a provider from a browser test.
  dashboardMode: 'ok' | 'no-history' | 'unavailable' = 'ok';
  dashboardNow = '2026-09-30T12:00:00Z';
  dashboardFetchedAt = '2026-09-30T12:00:00Z';
  readonly dashboardRanges: DashboardRange[] = [];
  tickerReads = 0;
  marketTicker: MarketTickerResponse = MarketTickerResponse.parse({
    status: 'ok', now: '2026-09-30T12:01:00Z', fetchedAt: '2026-09-30T12:01:00Z',
    ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60234.56, providerTime: '2026-09-30T12:00:30Z' },
  });
  /** Weather projection (ADR-0033 W1). Synthetic public-provider shape, served to both Dashboard and Today. */
  weather: WeatherResponse = sampleWeather();
  weatherReads = 0;
  weatherLocationReads = 0;
  readonly weatherLocationBodies: string[] = [];
  /** Health daily card (HC2): synthetic numbers only, served to the Dashboard board. */
  health = HealthResponse.parse({
    revision: 'a'.repeat(40), now: '2026-09-30T12:00:00Z', status: 'ok',
    day: '2026-09-29', staleDays: 0,
    metrics: [
      { key: 'steps', value: 12345, baseline: 10000, compare: 'above', series: healthSeries(10000, 200) },
      { key: 'headphone_min', value: 45.6, baseline: 30, compare: 'above', series: healthSeries(30, 4) },
      { key: 'first_move', value: 1290, baseline: 180, compare: 'below', series: healthSeries(180, 10) },
      { key: 'last_move', value: 900, baseline: 900, compare: 'usual', series: healthSeries(900, 12) },
    ],
  });
  healthReads = 0;
  /** Health history view (HC3b): synthetic numbers only, fetched lazily by the History toggle. */
  healthHistory = HealthHistoryResponse.parse({
    revision: 'a'.repeat(40), now: '2026-09-30T12:00:00Z', status: 'ok', days: healthHistoryDays(),
  });
  healthHistoryReads = 0;
  trainingRows: TrainingRow[] = [];
  /** `error`: /api/training answers 503 (Progress then shows "Training unavailable"). */
  trainingMode: 'ok' | 'error' | 'hang' = 'ok';
  trainingUnknownLines: string[] = [];
  #trainingBefore = new Map<string, TrainingRow[]>();
  /** B12: each applied edit's original row and the row it wrote, so an Undo can swap exactly that row back. */
  #trainingEdits = new Map<string, { before: TrainingRow; after: TrainingRow }>();
  session: 'ok' | 'signed-out' = 'ok';
  /** The account the session reports (switch it to simulate signing in as someone else). */
  account = ACCOUNT;
  /** `down`: every request fails as a network error and is not recorded (it never reached the server). */
  network: 'up' | 'down' = 'up';
  sessionMode: ReadMode = 'ok';
  tasksMode: ReadMode = 'ok';
  taskReads = 0;
  vault: TasksResponse['vault'] = { committedAt: '2026-09-26T12:07:00Z', fromApp: false };
  /** The read's writeBlock, e.g. a committed Git conflict in the task list. */
  writeBlock: ApiError | null = null;
  /** Largest `known=` list any task read asked about (review O1). */
  maxKnownAsked = 0;
  #rewritten = false;
  /** Blob of the task file in every read; change it to model a desktop edit. */
  blobSha = '2'.repeat(40);
  commandMode: CommandMode = 'ok';
  /** CAL-b: itemKey -> Google event id; a reload reads this back as "In Calendar". */
  calendarLinks: Record<string, string> = {};
  /** CAL-b: accepted events by event id -> item key (one entry per distinct event, for double-tap assertions). */
  calendarEvents: Record<string, string> = {};
  /** CAL-b: `offline` aborts, `unavailable` answers 503 `calendar-write-unavailable`. */
  calendarMode: 'ok' | 'offline' | 'unavailable' = 'ok';
  readonly calendarCreateBodies: string[] = [];
  readonly calendarRemoveBodies: string[] = [];
  readonly #calendarOperations = new Map<string, string>();
  open: TaskView[] = [];
  doneToday: TaskView[] = [];
  /** Every POST body exactly as received, including failed attempts. */
  readonly bodies: string[] = [];
  readonly applied: Command[] = [];
  /** Linked-note answers by target; the mock resolves `links[linkIndex]` of the requested task like the server. */
  notes = new Map<string, { path: string; markdown: string }>();
  /** Every decoded linked-note request, and the raw URL it came on (must never carry task text). */
  /** Active Work Now: Markdown, `null` for an absent file, or `'error'` for a 503. */
  activeWork: string | null | 'error' = null;
  activeWorkItems: Extract<ActiveWorkResponse, { status: 'ok' }>['items'] = [];
  unknownNowLines: string[] = [];
  #awBefore = new Map<string, Extract<ActiveWorkResponse, { status: 'ok' }>['items']>();
  readonly noteRequests: { req: LinkedNoteRequest; url: string }[] = [];
  readonly #receipts = new Map<string, Receipt>();
  #held: (() => void)[] = [];
  #revision = sha();

  triage: TriageResponse = { revision: 'a'.repeat(40), now: '2026-09-27T12:00:00Z', feedState: 'absent', generatedAt: null,
    cards: [], checkins: [], droppedCards: 0, droppedCheckins: 0, decisions: [], applied: {}, appliedUpdatedAt: null };

  scouts: ScoutsResponse = ScoutsResponse.parse({
    revision: 'a'.repeat(40), now: '2026-09-27T08:50:02+02:00', scouts: [
      { state: 'ok', file: 'city-events.json', status: {
        schemaVersion: 1, scoutId: 'city-events', displayName: 'City events', schedule: 'daily 06:50', expectedEveryHours: 24,
        lastAttemptAt: '2026-09-27T06:50:02+02:00', lastSuccessAt: null, runStatus: 'failed', sources: null, aiHealth: null,
        findings: null, added: null, errors: 1, lastError: 'runner could not start', latestOutput: null,
        history: [{ at: '2026-09-27T06:50:02+02:00', status: 'failed', findings: null }],
      } },
      { state: 'ok', file: 'learning.json', status: {
        schemaVersion: 1, scoutId: 'learning', displayName: 'Learning opportunities', schedule: 'daily 07:00', expectedEveryHours: 24,
        lastAttemptAt: '2026-09-27T07:00:00+02:00', lastSuccessAt: '2026-09-27T07:00:00+02:00', runStatus: 'success',
        sources: { configured: 3, successful: 3 }, aiHealth: 'healthy', findings: 4, added: 2, errors: 0,
        lastError: 'Previous run: one source timed out', latestOutput: 'Discoveries/Learning.md',
        history: [
          { at: '2026-09-26T07:00:00+02:00', status: 'degraded', findings: 2 },
          { at: '2026-09-27T07:00:00+02:00', status: 'success', findings: 4 },
        ],
      } },
      { state: 'unreadable', file: 'unreadable.json' },
    ],
  });
  readonly scoutOutputRequests: string[] = [];
  /** A scout id mapped to a promise holds that output read open until it settles (slow-scout tests). */
  readonly scoutOutputGates = new Map<string, Promise<void>>();
  scoutOutputs = new Map<string, string>([['learning', [
    '# Learning findings',
    '',
    'Four synthetic opportunities.',
    '',
    '| Opportunity | Provider | When |',
    '| --- | --- | --- |',
    '| [Platform workshop](https://example.com/workshop) | Example Guild | Tuesday |',
    '| Cloud meetup | Sample Community | Wednesday |',
    '| Mentoring circle | Demo Network | Friday |',
    '| Fourth listing | Example Org | Saturday |',
    '',
    '<script>alert(1)</script>',
  ].join('\n')]]);
  /** Synthetic Research Radar read model. Decisions are appended by the radar decision endpoint, then re-parsed. */
  radar = RadarResponse.parse({
    revision: 'a'.repeat(40),
    now: '2026-09-30T10:00:00Z',
    sources: {
      dailyScout: { state: 'ok', count: 2 },
      readingBriefs: { state: 'absent', count: 0 },
      importantUpdates: { state: 'absent', count: 0 },
      explained: { state: 'absent', count: 0 },
    },
    papers: [
      { paperId: '00000000000000000001', rank: 1, title: 'Synthetic sparse routing', why: 'A faster phone-side lookup.',
        topic: 'systems', sourceUrl: 'https://example.com/paper-1', sourceDate: '2026-09-29',
        badges: ['important'], read: { kind: 'source', url: 'https://example.com/paper-1' } },
      { paperId: '00000000000000000002', rank: 2, title: 'Graph retrieval on device', why: 'Small, on-device recall.',
        topic: 'systems', sourceUrl: 'https://example.com/paper-2', sourceDate: '2026-09-28',
        badges: [], read: { kind: 'note', path: 'Research/Radar/Notes/graph-retrieval.md' } },
    ],
    topics: [{ topic: 'systems', count: 2 }],
    decisions: [],
    applied: {},
    appliedUpdatedAt: null,
    warnings: [],
  });
  radarReads = 0;
  readonly radarBodies: string[] = [];
  /** Synthetic server-resolved note bodies by paper id; never a client-supplied path. */
  radarNotes = new Map<string, string>([['00000000000000000002', lines(
    '# Graph retrieval on device',
    '',
    'Synthetic note body used only by the Radar e2e mock.',
  )]]);
  /** Completion history (ADR-0021): done-today tasks plus these earlier items, served newest first. */
  olderHistory: HistoryItem[] = [
    { source: 'active-work', description: 'Garden plan: beds ready [[Garden Plan]]', doneDate: '2026-09-23', links: ['Garden Plan'],
      locator: { path: 'Tasks/Active Work Now.md', blobSha: '3'.repeat(40), lineIndex: 12, lineText: '- [x] **Garden plan:** beds ready [[Garden Plan]] ✅ 2026-09-23', occurrencesAtRead: 1 } },
  ];
  /** Inbox notes (ADR-0022), by path: frontmatter is kept on edit, only the body changes. */
  inboxNotes = new Map<string, { title: string; date: string | null; blobSha: string; frontmatter: string; body: string }>([
    ['Inbox/Seed order - 2026-09-23.md', { title: 'Seed order', date: '2026-09-23', blobSha: 'd'.repeat(40),
      frontmatter: '---\ntype: inbox-note\n---\n', body: 'Tomatoes and **basil**.\n' }],
  ]);
  /** Every EditNote the mock applied (path, blob it was based on, body). */
  readonly noteEdits: { path: string; blobSha: string; body: string }[] = [];

  /** "This morning" (ADR-0029 Part 2): empty by default (the panel then stays hidden); morning.spec sets SAMPLE_MORNING. */
  morning: MorningResponse | null = null;
  /** Morning Brief (MB2): a stale-dated brief by default, so the card shows no brief rows and no unmocked 404 appears. */
  morningBrief: MorningBriefResponse = {
    revision: 'b'.repeat(40), date: '2000-01-01', generatedAt: '2000-01-01T04:31:00+01:00', source: 'fallback',
    unavailable: [], brief: { source: 'fallback', dayLine: 'Stale', gaps: [], todos: [] },
  };
  /** AI budget (AB2): a synthetic two-provider file by default; the vault-side writer (AB1) is not built yet. */
  aiBudget: AiBudgetResponse = {
    revision: 'c'.repeat(40), generatedAt: '2026-09-30T12:00:00+02:00',
    providers: [
      { id: 'claude', label: 'Claude weekly', kind: 'percent', value: 58, limit: 100, unit: null, resetsAt: '2026-10-05T04:00:00+02:00', history: [40, 44, 50, 58] },
      { id: 'scaleway', label: 'Scaleway credits', kind: 'money', value: 6.14, limit: null, unit: '$', resetsAt: null, history: null },
    ],
    freeRamGb: null,
  };
  /** AB3b: a synthetic per-provider usage summary ending on the Dashboard's own day. */
  aiUsage: AiUsageResponse = {
    revision: 'd'.repeat(40), generatedAt: '2026-09-30T11:45:00Z', skipped: 0,
    providers: {
      claude: { label: 'Claude Code', days: Array.from({ length: 10 }, (_, index) => usageRow(index, { outputTokens: (index + 1) * 100, cacheWriteTokens: 5, cacheReadTokens: 999_999 })) },
      codex: { label: 'Codex', days: Array.from({ length: 10 }, (_, index) => usageRow(index, { outputTokens: (index + 1) * 50, cacheWriteTokens: 0, cacheReadTokens: 999_999 })) },
      jev: { label: 'Jev', days: Array.from({ length: 10 }, (_, index) => usageRow(index, { calls: index + 2 })) },
      deepseek: { label: 'DeepSeek', currency: 'USD', days: Array.from({ length: 10 }, (_, index) => usageRow(index, { cost: (index + 1) / 10 })) },
      scaleway: { label: 'Scaleway', currency: 'EUR', days: Array.from({ length: 10 }, (_, index) => usageRow(index, { cost: (index + 1) / 4 })) },
    },
  };

  static readonly SAMPLE_MORNING: MorningResponse = MorningResponse.parse({
    revision: 'a'.repeat(40), date: '2026-09-30',
    brief: { status: 'ok', revision: 'a'.repeat(40), path: 'Research/Reading Briefs/Research Reading Brief - 2026-09-30.md', blobSha: 'e'.repeat(40),
      markdown: lines('# Research Reading Brief - 2026-09-30', '', '## Read today', '', '- [Synthetic Sparse Routing](https://arxiv.org/abs/2601.00001) - cheaper inference') },
    explained: [
      { status: 'ok', revision: 'a'.repeat(40), path: 'Research/Explained/2026-09-30 - synthetic-sparse-routing.md', blobSha: 'f'.repeat(40),
        markdown: lines('---', 'type: research-explained', 'status: complete', '---', '', '# Synthetic Sparse Routing', '', '## In plain words', '', 'A synthetic plain explanation.') },
      { status: 'ok', revision: 'a'.repeat(40), path: 'Research/Explained/2026-09-30 - synthetic-graph-study.md', blobSha: '9'.repeat(40),
        markdown: lines('---', 'type: research-explained', 'status: pending', '---', '', '# Synthetic Graph Study', '', 'Explanation pending; retried automatically.') },
    ],
  });

  /** Route a page, or a whole context: only a context route also sees requests made by a service worker. */
  async install(target: Page | BrowserContext): Promise<void> {
    const on = (glob: string, handle: (route: Route) => Promise<void>) =>
      target.route(glob, (route) => (this.network === 'down' ? route.abort('internetdisconnected') : handle(route)));
    await on('**/api/dashboard?**', (route) => this.#dashboard(route));
    await on('**/api/dashboard/ticker', (route) => {
      if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
      this.tickerReads++;
      return this.#json(route, 200, MarketTickerResponse.parse(this.marketTicker));
    });
    await on('**/api/weather/location', (route) => this.#weatherLocation(route));
    await on('**/api/weather', (route) => this.#weather(route));
    await on('**/api/health/history', (route) => this.#healthHistory(route));
    await on('**/api/health', (route) => this.#health(route));
    await on('**/api/morning', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, MorningResponse.parse(this.morning ?? { revision: 'a'.repeat(40), date: '2026-09-30', brief: null, explained: [] })));
    await on('**/api/morning-brief', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, MorningBriefResponse.parse(this.morningBrief)));
    await on('**/api/calendar/links', (route) => this.#calendarReadLinks(route));
    await on('**/api/calendar/events', (route) => this.#calendarCreate(route));
    await on('**/api/calendar/events/remove', (route) => this.#calendarRemove(route));
    await on('**/api/ai-budget', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, AiBudgetResponse.parse(this.aiBudget)));
    await on('**/api/ai-usage', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, AiUsageResponse.parse(this.aiUsage)));
    await on('**/api/scouts', (route) => this.session === 'signed-out'
      ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, ScoutsResponse.parse(this.scouts)));
    await on('**/api/scouts/output', async (route) => {
      if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
      const id = route.request().headers()['x-vc-scout'] ?? '';
      this.scoutOutputRequests.push(id);
      await this.scoutOutputGates.get(id);
      const markdown = this.scoutOutputs.get(id);
      return this.#json(route, 200, LinkedNoteResponse.parse(markdown !== undefined
        ? { status: 'ok', revision: this.#revision, blobSha: 'b'.repeat(40), path: `Discoveries/${id}.md`, markdown }
        : { status: 'refused', revision: this.#revision, code: 'not-found', message: 'No findings note yet.' }));
    });
    await on('**/api/radar/decisions', (route) => this.#radarDecision(route));
    await on('**/api/radar/read', (route) => this.#radarNote(route));
    await on('**/api/radar', (route) => this.#radar(route));
    await on('**/api/session', (route) => this.#session(route));
    await on('**/api/tasks**', (route) => this.#tasks(route));
    await on('**/api/commands', (route) => this.#command(route));
    await on('**/api/linked-note**', (route) => this.#linkedNote(route));
    await on('**/api/training', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' })
      : this.trainingMode === 'hang' ? new Promise<void>(() => {})
      : this.trainingMode === 'error' ? this.#json(route, 503, ApiError.parse({ code: 'upstream-unavailable', message: 'GitHub is unavailable.', retryable: true }))
      : this.#json(route, 200, TrainingResponse.parse({ status: 'ok', revision: this.#revision, blobSha: this.blobSha, rows: this.trainingRows, unknownLines: this.trainingUnknownLines })));
    await on('**/api/active-work', (route) => this.#activeWork(route));
    await on('**/api/triage', (route) => this.session === 'signed-out' ? route.fulfill({ status: 401, body: '' })
      : this.#json(route, 200, TriageResponse.parse({ ...this.triage, revision: this.#revision })));
    await on('**/api/history', (route) => this.#history(route));
    await on('**/api/notes', (route) => this.#notes(route));
    await on('**/api/notes/read', (route) => this.#noteRead(route));
  }

  #weather(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    this.weatherReads++;
    return this.#json(route, 200, WeatherResponse.parse(this.weather));
  }

  #weatherLocation(route: Route) {
    const request = route.request();
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    this.weatherLocationReads++;
    this.weatherLocationBodies.push(request.postData() ?? '');
    if (request.headers()['x-vc-request'] !== '1') return this.#json(route, 403, ApiError.parse({ code: 'forbidden', message: 'request origin not allowed', retryable: false }));
    if (request.headers()['x-vc-account'] !== this.account) {
      return this.#json(route, 409, ApiError.parse({ code: 'account-mismatch', message: 'Other account.', retryable: false }));
    }
    return this.#json(route, 200, WeatherResponse.parse(this.weather));
  }

  #health(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    this.healthReads++;
    return this.#json(route, 200, HealthResponse.parse(this.health));
  }

  #healthHistory(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    this.healthHistoryReads++;
    return this.#json(route, 200, HealthHistoryResponse.parse(this.healthHistory));
  }

  /** CAL-b: per-item event ids only, like the real `GET /api/calendar/links`. */
  #calendarReadLinks(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    return this.#json(route, 200, { revision: 'c'.repeat(40), links: { ...this.calendarLinks } });
  }

  #calendarCreate(route: Route) {
    const request = route.request();
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    if (this.calendarMode === 'offline') return route.abort('internetdisconnected');
    if (this.calendarMode === 'unavailable') {
      return this.#json(route, 503, ApiError.parse({ code: 'calendar-write-unavailable', message: 'not configured', retryable: true }));
    }
    if (request.headers()['x-vc-request'] !== '1') return this.#json(route, 403, ApiError.parse({ code: 'forbidden', message: 'request origin not allowed', retryable: false }));
    if (request.headers()['x-vc-account'] !== this.account) {
      return this.#json(route, 409, ApiError.parse({ code: 'account-mismatch', message: 'Other account.', retryable: false }));
    }
    const raw = request.postData() ?? '';
    this.calendarCreateBodies.push(raw);
    const parsed = CalendarCreateBody.safeParse(JSON.parse(raw));
    if (!parsed.success) return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'invalid calendar event', retryable: false }));
    const body = parsed.data;
    const existing = this.#calendarOperations.get(body.operationId);
    if (existing) {
      return this.#json(route, 200, { eventId: existing, link: { eventId: existing, operationId: body.operationId, createdAt: '2026-09-24T12:00:00+02:00' } });
    }
    if (this.calendarLinks[body.itemKey]) {
      return this.#json(route, 409, ApiError.parse({ code: 'conflict:stale', message: 'calendar link already exists for this item', retryable: true }));
    }
    const eventId = `event-${Object.keys(this.calendarEvents).length + 1}`;
    this.#calendarOperations.set(body.operationId, eventId);
    this.calendarEvents[eventId] = body.itemKey;
    this.calendarLinks[body.itemKey] = eventId;
    return this.#json(route, 200, { eventId, link: { eventId, operationId: body.operationId, createdAt: '2026-09-24T12:00:00+02:00' } });
  }

  #calendarRemove(route: Route) {
    const request = route.request();
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    if (this.calendarMode === 'offline') return route.abort('internetdisconnected');
    if (this.calendarMode === 'unavailable') {
      return this.#json(route, 503, ApiError.parse({ code: 'calendar-write-unavailable', message: 'not configured', retryable: true }));
    }
    if (request.headers()['x-vc-request'] !== '1') return this.#json(route, 403, ApiError.parse({ code: 'forbidden', message: 'request origin not allowed', retryable: false }));
    if (request.headers()['x-vc-account'] !== this.account) {
      return this.#json(route, 409, ApiError.parse({ code: 'account-mismatch', message: 'Other account.', retryable: false }));
    }
    const raw = request.postData() ?? '';
    this.calendarRemoveBodies.push(raw);
    const body = JSON.parse(raw) as { itemKey?: string };
    if (body.itemKey) delete this.calendarLinks[body.itemKey];
    return this.#json(route, 200, { removed: true });
  }

  #dashboard(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const parsed = DashboardRange.safeParse(new URL(route.request().url()).searchParams.get('range') ?? '1W');
    if (!parsed.success) return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'Invalid range.', retryable: false }));
    const range = parsed.data;
    this.dashboardRanges.push(range);
    const plan = DASHBOARD_RANGE_PLAN[range];
    const count = plan.spanSeconds / plan.granularitySeconds;
    const start = Date.parse(this.dashboardNow) - plan.spanSeconds * 1000;
    const points = Array.from({ length: count }, (_, index) => ({
      time: new Date(start + index * plan.granularitySeconds * 1000).toISOString(),
      open: 60000 + index, high: 60100 + index, low: 59900 + index, close: 60000 + index,
    })).filter((_, index) => index !== 2); // A real missing bucket, not an interpolated point.
    const meta = { title: 'BTC / USD', provenance: 'Coinbase Exchange (public)',
      observedAt: '2026-09-30T11:59:00Z', fetchedAt: this.dashboardFetchedAt, drillthrough: null };
    const market = this.dashboardMode === 'unavailable'
      ? { ...meta, id: 'market', status: 'unavailable', observedAt: null, fetchedAt: null,
          reason: 'provider-error', note: 'Market data is unavailable.' }
      : { ...meta, id: 'market', status: 'ok',
          ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60123.45, providerTime: meta.observedAt },
          series: this.dashboardMode === 'no-history' ? null : { range, granularitySeconds: plan.granularitySeconds, points, missingIntervals: 1 },
          note: this.dashboardMode === 'no-history' ? 'History is unavailable.' : null };
    const weather = this.weather.status === 'ok'
      ? { id: 'weather', status: 'ok', title: 'Weather', provenance: 'DMI HARMONIE AROME Europe vs ECMWF IFS 9 km (Open-Meteo)',
          observedAt: null, fetchedAt: this.weather.projection.models[0]?.retrievedAt ?? null,
          note: this.weather.projection.partialError === 'one-model-unavailable' ? 'One model is unavailable; agreement is single-model.' : null,
          drillthrough: null, projection: this.weather.projection }
      : { id: 'weather', status: 'unavailable', title: 'Weather', provenance: 'Open-Meteo (DMI + ECMWF)',
          observedAt: null, fetchedAt: null, note: 'Weather is unavailable.', drillthrough: null, reason: this.weather.reason };
    return this.#json(route, 200, DashboardResponse.parse({ now: this.dashboardNow, cards: [market, weather,
      { id: 'ai-usage', status: 'not-configured', title: 'AI usage', provenance: 'Not configured',
        observedAt: null, fetchedAt: null, drillthrough: null, note: 'No approved usage source is connected yet.' },
    ] }));
  }

  #radar(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    this.radarReads += 1;
    return this.#json(route, 200, RadarResponse.parse(this.radar));
  }

  #radarNote(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const paperId = route.request().headers()[RADAR_PAPER_HEADER.toLowerCase()] ?? '';
    const markdown = this.radarNotes.get(paperId);
    return this.#json(route, 200, RadarNoteResponse.parse(markdown !== undefined
      ? { status: 'ok', revision: this.#revision, path: `Research/Radar/Notes/${paperId}.md`, blobSha: 'e'.repeat(40), markdown }
      : { status: 'refused', revision: this.#revision, code: 'missing', message: 'No Radar note for this paper.' }));
  }

  #radarDecision(route: Route) {
    const request = route.request();
    const raw = request.postData() ?? '';
    this.radarBodies.push(raw);
    if (request.headers()['x-vc-request'] !== '1') return this.#json(route, 403, ApiError.parse({ code: 'forbidden', message: 'request origin not allowed', retryable: false }));
    if (request.headers()['x-vc-account'] !== this.account) {
      return this.#json(route, 409, ApiError.parse({ code: 'account-mismatch', message: 'Other account.', retryable: false }));
    }
    const command = ResearchRadarDecideCommand.parse(JSON.parse(raw));
    const existing = this.radar.decisions.find((line) => line.decisionId === command.operationId);
    if (existing) {
      return this.#json(route, 200, Receipt.parse({ operationId: command.operationId, status: 'already-applied',
        path: 'Research/Radar/Decisions/2026-09.jsonl', commitSha: this.#revision, blobSha: 'f'.repeat(40),
        effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId } }));
    }
    this.radar.decisions.push({ ...RadarDecisionLine.parse({
      schemaVersion: 1,
      decisionId: command.operationId,
      paperId: command.payload.paperId,
      decision: command.payload.decision,
      undoes: command.payload.undoes,
      at: command.occurredAt,
      card: command.payload.card,
    }), month: this.radar.now.slice(0, 7) });
    return this.#json(route, 200, Receipt.parse({ operationId: command.operationId, status: 'applied',
      path: 'Research/Radar/Decisions/2026-09.jsonl', commitSha: this.#revision, blobSha: 'f'.repeat(40),
      effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId } }));
  }

  #history(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const today: HistoryItem[] = this.doneToday.map((t) => ({ source: 'todo', description: t.description, doneDate: t.done ?? TODAY,
      locator: { ...t.locator, blobSha: this.blobSha }, links: t.links }));
    const items = [...today, ...this.olderHistory].sort((a, b) => b.doneDate.localeCompare(a.doneDate));
    return this.#json(route, 200, HistoryResponse.parse({ revision: this.#revision, today: TODAY, items }));
  }

  #notes(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const notes = [...this.inboxNotes].map(([path, n]) => ({ path, title: n.title, date: n.date, blobSha: n.blobSha }))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title));
    return this.#json(route, 200, NotesResponse.parse({ revision: this.#revision, notes }));
  }

  #noteRead(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    // The path must arrive in the header only, never in the URL.
    if (new URL(route.request().url()).search !== '') throw new Error('mock: note read carried a query');
    const path = decodeNoteHeader(route.request().headers()[NOTE_HEADER.toLowerCase()]);
    if (path === null) return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'invalid note path', retryable: false }));
    const n = this.inboxNotes.get(path);
    return this.#json(route, 200, NoteReadResponse.parse(n
      ? { status: 'ok', revision: this.#revision, path, blobSha: n.blobSha, markdown: n.frontmatter + n.body, frontmatter: n.frontmatter, body: n.body }
      : { status: 'refused', revision: this.#revision, code: 'not-found', message: 'the note does not exist any more; reload the list' }));
  }

  #json(route: Route, status: number, body: unknown) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  }

  /** Answers a read that is not `ok`; false means serve it normally. */
  async #readFailure(route: Route, mode: ReadMode): Promise<boolean> {
    if (mode === 'ok') return false;
    if (mode === 'offline') await route.abort('internetdisconnected');
    else if (mode === 'error') await route.fulfill({ status: 502, body: 'Bad gateway' });
    // `hang`: never answered; the page aborts it.
    return true;
  }

  async #session(route: Route) {
    if (await this.#readFailure(route, this.sessionMode)) return;
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    return this.#json(route, 200, SessionResponse.parse({ accountKey: this.account }));
  }

  #activeWork(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    if (this.activeWork === 'error') {
      return this.#json(route, 503, ApiError.parse({ code: 'upstream-unavailable', message: 'GitHub is unavailable.', retryable: true }));
    }
    const body = this.activeWork === null
      ? { status: 'absent', revision: this.#revision }
      : { status: 'ok', revision: this.#revision, blobSha: '5'.repeat(40), markdown: this.activeWork, items: this.activeWorkItems, unknownNowLines: this.unknownNowLines, today: TODAY };
    return this.#json(route, 200, ActiveWorkResponse.parse(body));
  }

  #linkedNote(route: Route) {
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const request = route.request();
    const req = decodeLinkedNoteHeader(request.headers()[LINKED_NOTE_HEADER.toLowerCase()]);
    if (!req) return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'invalid linked-note request', retryable: false }));
    this.noteRequests.push({ req, url: request.url() });
    const task = [...this.open, ...this.doneToday].find((t) => t.locator.lineText === req.taskLocator.lineText);
    const target = task?.links[req.linkIndex];
    const note = target === undefined ? undefined : this.notes.get(target);
    const body = note
      ? { status: 'ok', revision: this.#revision, path: note.path, blobSha: '4'.repeat(40), markdown: note.markdown }
      : { status: 'refused', revision: this.#revision, code: task ? 'not-found' : 'task-changed', message: 'refused' };
    return this.#json(route, 200, LinkedNoteResponse.parse(body));
  }

  async #tasks(route: Route) {
    this.taskReads += 1;
    if (await this.#readFailure(route, this.tasksMode)) return;
    if (this.session === 'signed-out') return route.fulfill({ status: 401, body: '' });
    const asked = new URL(route.request().url()).searchParams.get('known')?.split(',').filter(Boolean) ?? [];
    this.maxKnownAsked = Math.max(this.maxKnownAsked, asked.length);
    // After a history rewrite no earlier commit is on main any more (review O6).
    const known = Object.fromEntries(asked.map((c) => [c, this.#rewritten ? ('not-included' as const) : ('included' as const)]));
    // Locators as the Worker builds them: this read's blob, and how many indexed lines share the text.
    const lines = [...this.open, ...this.doneToday].map((t) => t.locator.lineText);
    const located = (t: TaskView): TaskView => ({
      ...t,
      locator: {
        ...t.locator,
        blobSha: this.blobSha,
        occurrencesAtRead: lines.filter((l) => l === t.locator.lineText).length,
      },
    });
    const open = this.open.map(located);
    const body = TasksResponse.parse({
      revision: this.#revision,
      blobSha: this.blobSha,
      today: TODAY,
      timeZone: 'Europe/Copenhagen',
      vault: this.vault,
      writeBlock: this.writeBlock,
      known,
      todayTasks: open.filter((t) => t.due === TODAY),
      overdue: open.filter((t) => t.due !== null && t.due < TODAY),
      allOpen: open,
      doneToday: this.doneToday.map(located),
    });
    return this.#json(route, 200, body);
  }

  async #command(route: Route) {
    const request = route.request();
    const raw = request.postData() ?? '';
    this.bodies.push(raw);
    if (request.headers()['x-vc-request'] !== '1') return this.#json(route, 403, { code: 'forbidden', message: 'x', retryable: false });
    const command = Command.parse(JSON.parse(raw));
    // Like the Worker: the item's account binding travels outside the body and must match the session (A7).
    if (request.headers()['x-vc-account'] !== this.account) {
      return this.#json(route, 409, ApiError.parse({ code: 'account-mismatch', message: 'Other account.', retryable: false }));
    }

    const mode = this.commandMode;
    if (mode === 'hold') await new Promise<void>((resolve) => this.#held.push(resolve));
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'unavailable') {
      return this.#json(route, 503, ApiError.parse({ code: 'upstream-unavailable', message: 'GitHub is unavailable.', retryable: true }));
    }
    if (typeof mode === 'object') return this.#json(route, 409, ApiError.parse({ ...mode.refuse, operationId: command.operationId }));

    // Like the Worker (ADR-0013): an Undo's token must be its completion's commit.
    if ((command.type === 'UndoCompleteTask' || command.type === 'UndoActiveWork' || command.type === 'UndoEditTraining') && this.#receipts.get(command.payload.target.operationId)?.commitSha !== command.payload.targetCommit) {
      return this.#json(route, 400, ApiError.parse({ code: 'invalid', message: 'Undo target does not match.', retryable: false }));
    }
    const previous = this.#receipts.get(command.operationId);
    if (previous) return this.#json(route, 200, { ...previous, status: 'already-applied' });
    // B12: an edit locates its row by exact cells; moved => conflict, ambiguous => conflict, never a guess.
    if (command.type === 'EditTraining') {
      const matches = this.trainingRows.filter((r) => sameTrainingRow(r, command.payload.row)).length;
      if (matches === 0) return this.#json(route, 409, ApiError.parse({ code: 'conflict:training-changed', message: 'That session changed in Obsidian.', retryable: false }));
      if (matches > 1) return this.#json(route, 409, ApiError.parse({ code: 'conflict:ambiguous', message: 'More than one session matches.', retryable: false }));
    }
    if (command.type === 'UndoEditTraining') {
      const edit = this.#trainingEdits.get(command.payload.target.operationId);
      if (!edit || !this.trainingRows.some((r) => sameTrainingRow(r, edit.after))) {
        return this.#json(route, 409, ApiError.parse({ code: 'conflict:training-changed', message: 'That session changed in Obsidian.', retryable: false }));
      }
    }
    const receipt = Receipt.parse(this.#apply(command));
    this.#receipts.set(command.operationId, receipt);
    this.applied.push(command);
    return this.#json(route, 200, receipt);
  }

  /** A desktop commit to the task list: new revision and blob, these open tasks. */
  desktopEdit(open: TaskView[]): void {
    this.#revision = sha();
    this.blobSha = sha();
    this.open = open;
  }

  /** Someone force-pushed main: new head, and none of the earlier commits is an ancestor of it any more (O6). */
  rewriteHistory(): void {
    this.#revision = sha();
    this.#rewritten = true;
  }

  /** Answer every held request (as `ok`) and stop holding new ones. */
  release(): void {
    this.commandMode = 'ok';
    for (const resolve of this.#held.splice(0)) resolve();
  }

  get heldCount(): number {
    return this.#held.length;
  }

  #apply(command: Command): Receipt {
    this.#revision = sha();
    const base = { operationId: command.operationId, status: 'applied' as const, commitSha: this.#revision, blobSha: sha() };
    if (command.type !== 'CaptureNote' && command.type !== 'EditNote') this.blobSha = base.blobSha;
    switch (command.type) {
      case 'LogTraining': {
        const s = command.payload.session;
        this.#trainingBefore.set(command.operationId, structuredClone(this.trainingRows));
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(s.when));
        this.trainingRows.push({ date: copenhagenDay(s.when), time: parts, type: s.type, distance: s.type === 'Run' ? s.distance.toFixed(1) : '', duration: String(s.duration), weight: s.type === 'Gym' && s.weight !== undefined ? s.weight.toFixed(1) : '', split: s.type === 'Gym' ? (s.split === 'Group' ? `Group: ${s.className ?? ''}` : s.split) : '', note: s.note ?? '' });
        this.trainingRows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
        return { ...base, path: 'Health/Training Log.md', effect: { kind: 'training', op: 'logged', lineText: '| synthetic session |' } };
      }
      case 'UndoLogTraining': {
        const before = this.#trainingBefore.get(command.payload.target.operationId);
        if (!before) throw new Error('mock: unknown training undo');
        this.trainingRows = before;
        return { ...base, path: 'Health/Training Log.md', effect: { kind: 'training', op: 'undone', lineText: '| synthetic session |' } };
      }
      case 'EditTraining': {
        const { row, session } = command.payload;
        const index = this.trainingRows.findIndex((r) => sameTrainingRow(r, row));
        if (index < 0) throw new Error('mock: editing an unknown row');
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(session.when));
        const replacement: TrainingRow = { date: copenhagenDay(session.when), time: parts, type: session.type,
          distance: session.type === 'Run' ? session.distance.toFixed(1) : '', duration: String(session.duration),
          weight: session.type === 'Gym' && session.weight !== undefined ? session.weight.toFixed(1) : '',
          split: session.type === 'Gym' ? (session.split === 'Group' ? `Group: ${session.className ?? ''}` : session.split) : '',
          note: session.note ?? '' };
        this.#trainingEdits.set(command.operationId, { before: row, after: replacement });
        this.trainingRows = this.trainingRows.map((r, i) => (i === index ? replacement : r));
        this.trainingRows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
        return { ...base, path: 'Health/Training Log.md', effect: { kind: 'training', op: 'edited', lineText: '| synthetic session |' } };
      }
      case 'UndoEditTraining': {
        const edit = this.#trainingEdits.get(command.payload.target.operationId);
        const index = edit ? this.trainingRows.findIndex((r) => sameTrainingRow(r, edit.after)) : -1;
        if (!edit || index < 0) throw new Error('mock: unknown training edit undo');
        this.trainingRows = this.trainingRows.map((r, i) => (i === index ? edit.before : r));
        this.trainingRows.sort((a, b) => (b.date + b.time).localeCompare(a.date + b.time));
        return { ...base, path: 'Health/Training Log.md', effect: { kind: 'training', op: 'undone', lineText: '| synthetic session |' } };
      }
      case 'MoodCheckin':
        return { ...base, path: `Journal/Daily/${command.payload.date}.md`, effect: { kind: 'mood', op: 'checked-in' } };
      case 'UndoMoodCheckin':
        return { ...base, path: `Journal/Daily/${command.payload.target.payload.date}.md`, effect: { kind: 'mood', op: 'undone' } };
      case 'ReportFeedback':
        return { ...base, path: 'Projects/Vault Companion/Vault Companion - Ready Backlog.md', effect: { kind: 'report', op: 'reported' } };
      case 'UndoReportFeedback':
        return { ...base, path: 'Projects/Vault Companion/Vault Companion - Ready Backlog.md', effect: { kind: 'report', op: 'undone' } };
      case 'TriageDecide': {
        const { eventId, decision, outcome, undoes, card } = command.payload;
        this.triage.decisions.push({ decisionId: command.operationId, eventId, decision, outcome, undoes, at: command.occurredAt, title: card.title, start: card.start });
        const path = `Events/Triage/Decisions/${copenhagenDay(command.occurredAt).slice(0, 7)}.jsonl`;
        return { ...base, path, effect: { kind: 'triage-decided', path, decisionId: command.operationId } };
      }
      case 'CaptureActiveWork': {
        const p = command.payload;
        const lineText = '- [ ] **' + p.name + ':**' + (p.next ? ' Next: ' + p.next : '') + (p.review ? ' ⏳ ' + p.review : '') + (p.link ? ' ' + p.link : '');
        this.activeWork ??= '## Now';
        this.activeWorkItems.push({ name: p.name, outcome: null, next: p.next ?? null, review: p.review ?? null,
          link: p.link ?? null, needsReview: !!p.review && p.review < TODAY,
          locator: { path: 'Tasks/Active Work Now.md', blobSha: base.blobSha, lineIndex: 10 + this.activeWorkItems.length, lineText, occurrencesAtRead: 1 } });
        return { ...base, path: 'Tasks/Active Work Now.md', effect: { kind: 'active-work', op: 'captured', beforeLineText: null, afterLineText: lineText } };
      }
      case 'ReviewActiveWork':
      case 'EditActiveWork': {
        const p = command.payload;
        const item = this.activeWorkItems.find((i) => i.locator.lineText === p.item.lineText && i.locator.lineIndex === p.item.lineIndex);
        if (!item) throw new Error('mock: unknown active work item');
        this.#awBefore.set(command.operationId, structuredClone(this.activeWorkItems));
        let afterLineText: string | null = null;
        if (command.type === 'EditActiveWork') {
          Object.assign(item, command.payload.changes);
        } else if (command.payload.action === 'keep') {
          item.review = '2026-10-01'; item.needsReview = false;
        } else {
          this.activeWorkItems = this.activeWorkItems.filter((i) => i !== item);
        }
        if (this.activeWorkItems.includes(item)) {
          afterLineText = '- [ ] **' + item.name + ':**' + (item.next ? ' Next: ' + item.next : '') + (item.review ? ' ⏳ ' + item.review : '') + (item.link ? ' ' + item.link : '');
          item.locator = { ...item.locator, lineText: afterLineText, blobSha: base.blobSha };
        }
        return { ...base, path: p.item.path, effect: { kind: 'active-work', op: command.type === 'EditActiveWork' ? 'edited' : command.payload.action,
          beforeLineText: p.item.lineText, afterLineText } };
      }
      case 'UndoActiveWork': {
        const before = this.#awBefore.get(command.payload.target.operationId);
        if (!before) throw new Error('mock: unknown active work undo');
        this.activeWorkItems = structuredClone(before);
        return { ...base, path: 'Tasks/Active Work Now.md', effect: { kind: 'active-work', op: 'undone', beforeLineText: null, afterLineText: command.payload.target.payload.item.lineText } };
      }
      case 'EditTask': {
        const { task: locator, changes } = command.payload;
        const same = this.open.filter((t) => t.locator.lineText === locator.lineText);
        const task = same.find((t) => t.locator.lineIndex === locator.lineIndex) ?? (same.length === 1 ? same[0] : undefined);
        if (!task) throw new Error('mock: editing an unknown task');
        const pick = <T,>(v: T | undefined, old: T): T => (v === undefined ? old : v);
        const updated = { description: changes.text ?? task.description, due: pick(changes.due, task.due),
          scheduled: pick(changes.scheduled, task.scheduled), priority: pick(changes.priority, task.priority) };
        const icons = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' };
        const afterLineText = ['- [ ]', updated.description, updated.priority ? icons[updated.priority] : '',
          updated.scheduled ? '⏳ ' + updated.scheduled : '', updated.due ? '📅 ' + updated.due : ''].filter(Boolean).join(' ');
        // Keep the wire TaskView strict: text is a changes field, not a TaskView field.
        this.open = this.open.map((t) => t === task ? { ...task, description: updated.description,
          due: updated.due, scheduled: updated.scheduled, priority: updated.priority,
          locator: { ...task.locator, blobSha: base.blobSha, lineText: afterLineText } } : t);
        return { ...base, path: locator.path, effect: { kind: 'edited', beforeLineText: locator.lineText, afterLineText } };
      }
      case 'CompleteTask': {
        const { lineText, lineIndex } = command.payload.task;
        // The line the locator names (identical lines are different tasks), else the only one with its text.
        const same = this.open.filter((t) => t.locator.lineText === lineText);
        const task = same.find((t) => t.locator.lineIndex === lineIndex) ?? (same.length === 1 ? same[0] : undefined);
        if (!task) throw new Error('mock: completing an unknown task');
        const completedLineText = `${lineText.replace('- [ ]', '- [x]')} ✅ ${TODAY}`;
        this.open = this.open.filter((t) => t !== task);
        this.doneToday.unshift({
          ...task,
          locator: { ...task.locator, lineText: completedLineText, lineIndex: 40 + this.doneToday.length },
          status: 'done',
          section: 'done',
          done: TODAY,
        });
        return {
          ...base,
          path: 'Tasks/To-Do List.md',
          effect: { kind: 'completed', completedLineText, openLineText: lineText, completedInPlace: false, doneDate: TODAY },
        };
      }
      case 'UndoCompleteTask': {
        const { lineText } = command.payload.target.payload.task;
        const done = this.doneToday.find((t) => t.locator.lineText.startsWith(lineText.replace('- [ ]', '- [x]')));
        if (!done) throw new Error('mock: undoing an unknown completion');
        this.doneToday = this.doneToday.filter((t) => t !== done);
        this.open.push({ ...done, locator: command.payload.target.payload.task, status: 'open', section: 'open', done: null });
        return { ...base, path: 'Tasks/To-Do List.md', effect: { kind: 'reopened', openLineText: lineText } };
      }
      case 'CaptureTask': {
        const lineText = `- [ ] ${command.payload.text}`;
        this.open.push(taskView(90 + this.open.length, command.payload.text, { due: null }));
        return { ...base, path: 'Tasks/To-Do List.md', effect: { kind: 'task-captured', lineText } };
      }
      case 'CaptureNote': {
        const path = 'Inbox/Synthetic note - 2026-09-24.md';
        this.inboxNotes.set(path, { title: 'Synthetic note', date: TODAY, blobSha: base.blobSha, frontmatter: '---\ntype: inbox-note\n---\n', body: command.payload.text + '\n' });
        return { ...base, path, effect: { kind: 'note-captured', path } };
      }
      case 'EditNote': {
        const { note, body } = command.payload;
        const n = this.inboxNotes.get(note.path);
        if (!n) throw new Error('mock: editing an unknown note');
        this.noteEdits.push({ path: note.path, blobSha: note.blobSha, body });
        this.inboxNotes.set(note.path, { ...n, blobSha: base.blobSha, body: body.endsWith('\n') ? body : body + '\n' });
        return { ...base, path: note.path, effect: { kind: 'note-edited', path: note.path } };
      }
    }
  }
}
