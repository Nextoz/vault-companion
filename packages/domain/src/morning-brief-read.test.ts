import { MorningBriefResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { serializeBriefFile, type BriefFile } from './morning-brief-file.ts';
import { createMorningBriefReadService } from './morning-brief-read.ts';
import { MORNING_BRIEF_PATH } from './paths.ts';
import { StoreUnavailable, type VaultStore } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const briefFile = (dayLine: string): BriefFile => ({
  schemaVersion: 1,
  date: '2026-10-02',
  generatedAt: '2026-10-02T04:31:00+02:00',
  source: 'model',
  unavailable: [],
  brief: {
    source: 'model',
    dayLine,
    gaps: [{ blockIndex: 3, start: '2026-10-02T09:00:00+02:00', end: '2026-10-02T10:30:00+02:00', suggestion: 'Deep work' }],
    todos: [{ id: 1, text: 'Pay the bill', due: '2026-10-02', bill: true }],
  },
});

const read = (store: VaultStore) => createMorningBriefReadService({ store }).readMorningBrief();

describe('readMorningBrief (MB2)', () => {
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
      brief: briefFile('Real day.').brief,
    });
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'Daily/Morning Digest/decoy.json': serializeBriefFile(briefFile('DECOY')) });
    await expect(read(store)).resolves.toMatchObject({ code: 'not-found', retryable: false });
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
