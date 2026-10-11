// GET /api/game (GAM1-A2) through createApp + the real read services + InMemoryStore. Synthetic fixtures only.
import {
  GameResponse,
  HEALTH_DAILY_CSV,
  LEARNING_PATH,
  TRAINING_PATH,
} from '@vault-companion/contracts';
import {
  characterConfig,
  createBooksService,
  createCommandService,
  createHealthService,
  createHistoryService,
  createLearningService,
  createResearchRadarService,
  createTrainingService,
  radarPaperId,
  type VaultStore,
} from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import { createGameService, type GameDeps } from './game.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-g4m2';
const TODO = 'Tasks/To-Do List.md';
const ACCOUNT = 'a'.repeat(64);
const NOW = new Date('2026-09-30T10:00:00Z');
const TIME_ZONE = 'Europe/Copenhagen';
const PAPER_SOURCE = 'https://example.com/game-paper';
const DECISION_ID = '55555555-5555-4555-8555-555555555555';
const DECISION_AT = '2026-09-30T12:00:00+02:00';

const TRAINING = `## Sessions\n| Date | Time | Type | Distance | Duration | Weight | Split | Note |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 2026-09-20 | | Group workout | | 30 min | | | ${SENTINEL} |\n`;
const LEARNING = `---\nprivate: synthetic\n---\n## Kinds\n\n| id | Name | Score means | Status |\n| --- | --- | --- | --- |\n| dictation | Dictation | accuracy | active |\n\n## Log\n| Date | Kind | Min | Score | Detail | Topic or source | Note |\n| --- | --- | --- | --- | --- | --- | --- |\n| 2026-09-22 | dictation | 15 | 7 | | weather | ${SENTINEL} |\n`;
const TODO_CONTENT = `## Open\n## Done\n- [x] Water the plants ${SENTINEL} #todo ✅ 2026-09-25\n`;
const BOOK = 'Books/Synthetic Book.md';
const BOOK_SENTINEL = 'SENTINEL-r3fl';
/** One book with three same-day reflections: the day cap awards two, but First Reflection lands. */
const BOOK_FIXTURE =
  '---\n' +
  'type: book\n' +
  'status: reading\n' +
  'author: Synthetic Author\n' +
  'totalPages: 100\n' +
  '---\n' +
  '# Synthetic Book\n' +
  '\n' +
  '## Progress\n' +
  '- 2026-09-21: p. 10\n' +
  '\n' +
  '## Reflections\n' +
  `### 2026-09-21\n${BOOK_SENTINEL} one\n` +
  `### 2026-09-21\n${BOOK_SENTINEL} two\n` +
  `### 2026-09-21\n${BOOK_SENTINEL} three\n`;

/** Ten days at 10k steps each cross the 100k lifetime rung exactly on 2024-01-10. */
const healthCsv = (steps: string): string =>
  'date,steps,headphone_min,first_move,last_move\n' +
  Array.from({ length: 10 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')},${steps},,,`).join('\n') + '\n';

async function radarFiles(): Promise<Record<string, string>> {
  const paperId = (await radarPaperId(PAPER_SOURCE))!;
  const line = JSON.stringify({ schemaVersion: 1, decisionId: DECISION_ID, paperId, decision: 'keep', undoes: null, at: DECISION_AT, card: { title: 'Synthetic paper', source: PAPER_SOURCE, topic: 'radar' } });
  const applied = JSON.stringify({ schemaVersion: 1, updatedAt: DECISION_AT, decisions: { [DECISION_ID]: { status: 'applied', at: DECISION_AT, message: 'synthetic', libraryPath: 'Research/Library/Saved Synthetic Paper.md' } } });
  return { 'Research/Radar/Decisions/2026-09.jsonl': `${line}\n`, 'Research/Radar/applied.json': applied };
}

async function baseFiles(steps = '10000'): Promise<Record<string, string>> {
  return { [TODO]: TODO_CONTENT, [TRAINING_PATH]: TRAINING, [LEARNING_PATH]: LEARNING, [HEALTH_DAILY_CSV]: healthCsv(steps), ...(await radarFiles()) };
}

let logs: LogRecord[];
let printed: unknown[][];

beforeEach(() => {
  logs = [];
  printed = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
});
afterEach(() => vi.restoreAllMocks());

function makeApp(store: VaultStore, override: Partial<GameDeps> = {}, wired = true) {
  const services: Services = {
    ...createCommandService({ store, now: () => NOW, timeZone: TIME_ZONE }),
    ...(wired ? createGameService({
      store,
      readTraining: () => createTrainingService({ store }).readTraining(),
      readLearning: () => createLearningService({ store }).readLearning(),
      readBooks: () => createBooksService({ store }).readBooks(),
      readHistory: () => createHistoryService({ store, now: () => NOW, timeZone: TIME_ZONE }).readHistory(),
      readRadar: () => createResearchRadarService({ store, now: () => NOW, timeZone: TIME_ZONE }).readResearchRadar(),
      readHealthHistory: () => createHealthService({ store, now: () => NOW, timeZone: TIME_ZONE }).readHealthHistory(),
      now: () => NOW,
      timeZone: TIME_ZONE,
      ...override,
    }) : {}),
  };
  return createApp({
    verify: async (token) => token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false },
    appOrigin: 'https://vc.example.com',
    services,
    log: (record) => logs.push(record),
  });
}

const get = async (store: VaultStore, override: Partial<GameDeps> = {}, token = 'good', wired = true) => {
  const app = makeApp(store, override, wired);
  const res = await app.request('/api/game', { headers: { 'Cf-Access-Jwt-Assertion': token } });
  return { res, body: res.status === 200 ? GameResponse.parse(await res.json()) : null };
};
const leaked = () => (JSON.stringify(logs) + JSON.stringify(printed)).includes(SENTINEL);

describe('GET /api/game', () => {
  it('returns the Character and step milestones from existing reads, no-store, no note/task text in logs', async () => {
    const store = await InMemoryStore.create(await baseFiles());
    const { res, body } = await get(store);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body!.unavailable).toEqual([]);
    expect(body!.character.xp).toBeGreaterThan(0);
    expect(body!.character.professions.map((p) => p.id)).toEqual(['athletics', 'scholar', 'lorekeeper', 'quartermaster']);
    expect(body!.stepMilestones!.earned).toContainEqual(expect.objectContaining({ id: 'steps-lifetime-100000', earnedDate: '2024-01-10' }));
    expect(body!.stepMilestones!.next).toEqual({ id: 'steps-lifetime-250000', name: '250K Steps', current: 100_000, target: 250_000 });
    expect(logs.at(-1)).toMatchObject({ route: '/api/game', status: 200, commitSha: (store as InMemoryStore).headCommit });
    expect(leaked()).toBe(false);
  });

  it('reports the live rules straight from characterConfig, so the web page cannot hard-code them', async () => {
    const store = await InMemoryStore.create(await baseFiles());
    const { body } = await get(store);
    const rules = body!.rules;
    expect(rules.rulesVersion).toBe(characterConfig.rulesVersion);
    expect(rules.level).toEqual({ ...characterConfig.level });
    expect(rules.skill).toEqual({ ...characterConfig.skill });
    expect(rules.rested).toEqual({ ...characterConfig.rested });
    expect(rules.professions).toEqual(characterConfig.professions.map((p) => ({ id: p.id, name: p.name })));
    expect(rules.ranks).toEqual(characterConfig.ranks.map((r) => ({ skill: r.skill, name: r.name, title: r.title })));
    expect(rules.sources.find((s) => s.id === 'training')).toEqual({
      id: 'training', profession: 'athletics', enabled: true, baseXp: 30, dailyCap: 2,
      minutes: { after: 20, step: 5, xp: 1, maxBonus: 20 }, overdue: null,
    });
  });

  it('names a failed source and never zeroes the remaining ones', async () => {
    const store = await InMemoryStore.create(await baseFiles());
    const failed = await get(store, { readTraining: async () => ({ code: 'upstream-unavailable', message: 'reader unavailable', retryable: true }) });
    expect(failed.body!.unavailable).toEqual(['training']);
    expect(failed.body!.character.xp).toBeGreaterThan(0);
    // The failed read contributes nothing (never a guessed value); the other sources are unchanged.
    const absent = await get(store, { readTraining: async () => ({ status: 'absent', revision: (store as InMemoryStore).headCommit }) });
    expect(absent.body!.unavailable).toEqual([]);
    expect(failed.body!.character).toEqual(absent.body!.character);
  });

  it('omits step milestones and names health when the health read fails', async () => {
    const store = await InMemoryStore.create(await baseFiles());
    const { body } = await get(store, { readHealthHistory: async () => ({ code: 'upstream-unavailable', message: 'reader unavailable', retryable: true }) });
    expect(body!.unavailable).toEqual(['health']);
    expect(body!.stepMilestones).toBeNull();
    expect(body!.character.xp).toBeGreaterThan(0);
  });

  it('never lets step rows change XP or level', async () => {
    const withSteps = await InMemoryStore.create(await baseFiles('10000'));
    const withoutSteps = await InMemoryStore.create(await baseFiles(''));
    const a = (await get(withSteps)).body!;
    const b = (await get(withoutSteps)).body!;
    expect([a.character.xp, a.character.level]).toEqual([b.character.xp, b.character.level]);
    expect(a.character).toEqual(b.character);
    expect(a.stepMilestones!.earned.length).toBeGreaterThan(0);
    expect(b.stepMilestones!.earned).toEqual([]);
    expect(b.stepMilestones!.next.current).toBe(0);
  });

  it('turns saved book reflections into Lorekeeper records and names the source when the read fails', async () => {
    const store = await InMemoryStore.create({ ...(await baseFiles()), [BOOK]: BOOK_FIXTURE });
    const withReflections = (await get(store)).body!;
    expect(withReflections.unavailable).toEqual([]);
    // Three same-day reflections: the daily cap awards two (50 XP); First Reflection unlocks, its text never logs.
    expect(withReflections.character.achievements.find((a) => a.id === 'first-reflection')).toMatchObject({ earned: true, locked: false });
    const failed = await get(store, { readBooks: async () => ({ code: 'upstream-unavailable', message: 'reader unavailable', retryable: true }) });
    expect(failed.body!.unavailable).toEqual(['reflections']);
    // Dropping the adapter loses the records, so First Reflection and the Lorekeeper XP would vanish: this fails then.
    const lorekeeper = (body: GameResponse) => body.character.professions.find((p) => p.id === 'lorekeeper')!;
    expect(failed.body!.character.achievements.find((a) => a.id === 'first-reflection')!.earned).toBe(false);
    expect(withReflections.character.xp).toBeGreaterThan(failed.body!.character.xp);
    expect(lorekeeper(withReflections).xp).toBeGreaterThan(lorekeeper(failed.body!).xp);
    expect((JSON.stringify(logs) + JSON.stringify(printed)).includes(BOOK_SENTINEL)).toBe(false);
  });

  it('is deterministic across identical reads', async () => {
    const store = await InMemoryStore.create(await baseFiles());
    expect(JSON.stringify((await get(store)).body)).toBe(JSON.stringify((await get(store)).body));
  });

  it('requires authentication and reads nothing without a valid token', async () => {
    const store = await InMemoryStore.create(await baseFiles());
    const head = vi.spyOn(store, 'head');
    const { res } = await get(store, {}, 'bad');
    expect(res.status).toBe(401);
    expect(head).not.toHaveBeenCalled();
    expect(leaked()).toBe(false);
  });

  it('404 when the service is not wired', async () => {
    const store = await InMemoryStore.create(await baseFiles());
    expect((await get(store, {}, 'good', false)).res.status).toBe(404);
  });
});
