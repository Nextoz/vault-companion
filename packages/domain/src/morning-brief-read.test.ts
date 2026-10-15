import { MorningBriefResponse, ScoutStatus, briefHackerNews } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { serializeBriefFile, type BriefFile } from './morning-brief-file.ts';
import { createMorningBriefReadService } from './morning-brief-read.ts';
import { MORNING_BRIEF_PATH, MORNING_BRIEF_STATUS_PATH } from './paths.ts';
import { StoreUnavailable, type VaultStore } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const briefFile = (dayLine: string): BriefFile => ({
  schemaVersion: 2,
  date: '2026-10-02',
  generatedAt: '2026-10-02T04:31:00+02:00',
  source: 'model',
  unavailable: [],
  unavailableReasons: {},
  brief: {
    meetings: [],
    source: 'model',
    dayLine,
    gaps: [{ blockIndex: 3, start: '2026-10-02T09:00:00+02:00', end: '2026-10-02T10:30:00+02:00', suggestion: 'Deep work' }],
    todos: [{ id: 1, text: 'Pay the bill', due: '2026-10-02', bill: true }],
  },
});

const read = (store: VaultStore) => createMorningBriefReadService({ store }).readMorningBrief();

const failedStatus = (lastError = 'internal'): ScoutStatus => ScoutStatus.parse({
  schemaVersion: 1,
  scoutId: 'morning-brief',
  displayName: 'Morning Brief',
  schedule: 'daily 06:31-07:31 Europe/Copenhagen',
  expectedEveryHours: 24,
  lastAttemptAt: '2026-10-04T04:31:00+02:00',
  lastSuccessAt: null,
  runStatus: 'failed',
  sources: { configured: 7, successful: 0 },
  aiHealth: 'failed',
  findings: 0,
  added: 0,
  errors: 1,
  lastError,
  latestOutput: null,
  history: [{ at: '2026-10-04T04:31:00+02:00', status: 'failed', findings: 0, operationId: '00000000-0000-4000-8000-0000000000aa' }],
});

describe('readMorningBrief (MB2)', () => {
  it('shows HN from a digest that arrived after the daily brief, without writing or rerunning it', async () => {
    const early = { ...briefFile('Early brief.'), unavailable: ['digest'], unavailableReasons: { digest: 'not-found' as const } };
    const store = await InMemoryStore.create({
      [MORNING_BRIEF_PATH]: serializeBriefFile(early),
      'Daily/Morning Digest/Morning Digest - 2026-10-02.md': '## Hacker News\n- **Synthetic late story** - 120 points; 15 comments on Hacker News ([link](https://news.ycombinator.com/item?id=123))',
      'Daily/Morning Digest/Morning Digest - 2026-10-01.md': '## Hacker News\n- **Yesterday** - 999 points ([link](https://news.ycombinator.com/item?id=124))',
    });
    const before = await store.head();
    const result = MorningBriefResponse.parse(await read(store));
    expect(briefHackerNews(result)?.items[0]?.title).toBe('Synthetic late story');
    expect(briefHackerNews(result)?.message).toBeNull();
    expect(result.brief.dayLine).toBe('Early brief.');
    expect(result.generatedAt).toBe(early.generatedAt);
    expect(result.unavailable).toEqual(['digest']); // Other early digest sections are not silently repaired.
    expect(await store.head()).toEqual(before);
    expect(store.text(MORNING_BRIEF_PATH)).not.toContain('Synthetic late story');
  });

  it('does not borrow HN from yesterday when the matching digest is absent', async () => {
    const store = await InMemoryStore.create({
      [MORNING_BRIEF_PATH]: serializeBriefFile(briefFile('Today.')),
      'Daily/Morning Digest/Morning Digest - 2026-10-01.md': '## Hacker News\n- **Yesterday** - 999 points ([link](https://news.ycombinator.com/item?id=124))',
    });
    expect(MorningBriefResponse.parse(await read(store)).brief.hackerNews).toBeUndefined();
  });

  it('isolates a failed late digest read to HN', async () => {
    const path = 'Daily/Morning Digest/Morning Digest - 2026-10-02.md';
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: serializeBriefFile(briefFile('Still usable.')), [path]: '## Hacker News' });
    const originalRead = store.readFile.bind(store);
    store.readFile = async (requested, revision) => {
      if (requested === path) throw new StoreUnavailable('synthetic');
      return originalRead(requested, revision);
    };
    const result = MorningBriefResponse.parse(await read(store));
    expect(result.brief.dayLine).toBe('Still usable.');
    expect(briefHackerNews(result)).toEqual({ items: [], message: 'Source unavailable.' });
  });

  it('pins the late note read to the listed revision and refuses a mismatched blob', async () => {
    const path = 'Daily/Morning Digest/Morning Digest - 2026-10-02.md';
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: serializeBriefFile(briefFile('Still usable.')), [path]: '## Hacker News' });
    const { commitSha } = await store.head();
    const originalRead = store.readFile.bind(store);
    store.readFile = async (requested, revision) => {
      expect(revision).toBe(commitSha);
      const file = await originalRead(requested, revision);
      return requested === path && file ? { ...file, blobSha: 'f'.repeat(40) } : file;
    };
    const result = MorningBriefResponse.parse(await read(store));
    expect(briefHackerNews(result)).toEqual({ items: [], message: 'Source unavailable.' });
  });

  it('projects the one brief file at the fixed path, and only that file', async () => {
    const store = await InMemoryStore.create({
      [MORNING_BRIEF_PATH]: serializeBriefFile(briefFile('Real day.')),
      'Daily/Morning Digest/decoy.json': serializeBriefFile(briefFile('DECOY day.')),
      'Daily/Morning Digest/decoy.md': '# not the brief\n',
    });
    const result = await read(store);
    expect(MorningBriefResponse.parse(result)).toEqual({
      revision: await store.head().then((h) => h.commitSha),
      date: '2026-10-02',
      generatedAt: '2026-10-02T04:31:00+02:00',
      source: 'model',
      unavailable: [],
  unavailableReasons: {},
      brief: briefFile('Real day.').brief,
    });
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'Daily/Morning Digest/decoy.json': serializeBriefFile(briefFile('DECOY')) });
    const result = await read(store);
    expect(result).toMatchObject({ kind: 'missing', statusError: null });
    expect(MorningBriefResponse.safeParse(result).success).toBe(false);
  });

  it('an absent file carries the Morning Brief status error code for the card', async () => {
    const store = await InMemoryStore.create({
      [MORNING_BRIEF_STATUS_PATH]: JSON.stringify(failedStatus('not-written:precondition-failed'), null, 2),
    });
    const result = await read(store);
    expect(result).toMatchObject({ kind: 'missing', statusError: 'not-written:precondition-failed' });
  });

  it('invalid JSON on disk is a typed invalid error, never a throw', async () => {
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: 'not json at all' });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid' });
  });

  it('valid JSON with the wrong shape is also invalid', async () => {
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: JSON.stringify({ schemaVersion: 1, date: '2026-10-02' }) });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid' });
  });

  it('a store outage is a retryable upstream-unavailable, never a throw', async () => {
    const down = {
      head: async () => { throw new StoreUnavailable('down'); },
      listFiles: async () => [],
      readFile: async () => null,
    } as unknown as VaultStore;
    await expect(read(down)).resolves.toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });

  it('surfaces the revision the read was pinned to', async () => {
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: serializeBriefFile(briefFile('Real day.')) });
    const { commitSha } = await store.head();
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await read(store)).toMatchObject({ revision: commitSha });
  });
});
