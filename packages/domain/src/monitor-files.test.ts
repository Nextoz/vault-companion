import { JobRadarResponse, VaultActivityResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createJobRadarReadService, createVaultActivityReadService, JOB_RADAR_PATH, VAULT_ACTIVITY_PATH } from './monitor-files.ts';
import { StoreUnavailable, type VaultStore } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

// Synthetic values, real vault-activity schema (M6a): a small 3-day window of the fixture shape.
const day = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-16',
  notes: 5,
  areas: { Events: 1, Learning: 1, '(root)': 1, Health: 2 },
  ...over,
});

const file = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  generatedAt: '2026-10-16T05:40:12+02:00',
  source: 'vault git history',
  windowDays: 3,
  start: '2026-10-14',
  end: '2026-10-16',
  days: [
    day({ date: '2026-10-14', notes: 11, areas: { Events: 2, '(root)': 3, Health: 3, Learning: 2, Career: 1 } }),
    day({ date: '2026-10-15', notes: 3, areas: { Health: 2, Projects: 1 } }),
    day(),
  ],
  currentStreak: 23,
  notesThisMonth: 79,
  areas30d: [{ area: 'Projects', notes: 28 }, { area: 'Health', notes: 27 }],
  excluded: ['Automation/', 'Tools/', '.obsidian/'],
  ...over,
});

const fileBytes = (over: Record<string, unknown> = {}): Uint8Array => new TextEncoder().encode(JSON.stringify(file(over)));

const read = (store: VaultStore) => createVaultActivityReadService({ store }).readVaultActivity();

describe('readVaultActivity (M6a)', () => {
  it('projects the one activity file at the fixed path, and only that file', async () => {
    const store = await InMemoryStore.create({
      [VAULT_ACTIVITY_PATH]: fileBytes(),
      'Automation/Monitors/decoy.json': fileBytes({ currentStreak: 999, notesThisMonth: 1 }),
    });
    const result = await read(store);
    expect(VaultActivityResponse.parse(result)).toEqual({
      revision: await store.head().then((h) => h.commitSha),
      ...file(),
    });
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'Automation/Monitors/decoy.json': fileBytes() });
    await expect(read(store)).resolves.toMatchObject({ code: 'not-found', retryable: false });
  });

  it('invalid JSON on disk is a typed invalid error, never a throw', async () => {
    const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: 'not json at all' });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid', retryable: false });
  });

  it('bytes that are not valid UTF-8 are a typed invalid error, never a throw', async () => {
    const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: new Uint8Array([0x22, 0xff, 0xfe, 0x22]) });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid', retryable: false });
  });

  it('a wrong envelope (unknown fields, wrong schema, bad values) is invalid', async () => {
    for (const raw of [
      JSON.stringify(file({ schema: 2 })),
      JSON.stringify(file({ windowDays: 'many' })),
      JSON.stringify(file({ days: [{ date: '16-10-2026', notes: 1, areas: {} }] })),
      JSON.stringify(file({ currentStreak: -1 })),
      JSON.stringify({ ...file(), extra: true }),
    ]) {
      const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: raw });
      await expect(read(store)).resolves.toMatchObject({ code: 'invalid', retryable: false });
    }
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
    const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: fileBytes() });
    const { commitSha } = await store.head();
    expect(await read(store)).toMatchObject({ revision: commitSha, currentStreak: 23 });
  });
});

// Synthetic values, real job-radar schema (M5a): a two-application slice of the fixture shape.
const radarFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  generatedAt: '2026-10-16T06:10:05+02:00',
  source: 'Job Search 2026 frontmatter',
  total: 2,
  counts: { saved: 1, applied: 1, interview: 0, offer: 0, closed: 0, other: 0 },
  otherStatuses: [],
  inFlight: [
    {
      title: 'Acme Platform',
      file: 'Job Search 2026/50 Acme Platform - 2026-09-01.md',
      status: 'submitted',
      stage: 'applied',
      updated: '2026-10-12',
      daysSinceUpdate: 4,
    },
    {
      title: 'Iota Infra',
      file: 'Job Search 2026/58 Iota Infra - 2026-09-09.md',
      status: null,
      stage: 'interview',
      updated: null,
      daysSinceUpdate: null,
    },
  ],
  followUps: [{ title: 'Acme Platform', stage: 'applied', due: '2026-10-14', field: 'follow_up', overdue: true }],
  stageTable: { submitted: 'applied' },
  applicationTypes: ['job-application'],
  ...over,
});

const radarFileBytes = (over: Record<string, unknown> = {}): Uint8Array => new TextEncoder().encode(JSON.stringify(radarFile(over)));

const readRadar = (store: VaultStore) => createJobRadarReadService({ store }).readJobRadar();

describe('readJobRadar (M5a)', () => {
  it('projects the one radar file at the fixed path, and only that file', async () => {
    const store = await InMemoryStore.create({
      [JOB_RADAR_PATH]: radarFileBytes(),
      'Automation/Monitors/decoy.json': radarFileBytes({ total: 999 }),
    });
    const result = await readRadar(store);
    expect(JobRadarResponse.parse(result)).toEqual({
      revision: await store.head().then((h) => h.commitSha),
      ...radarFile(),
    });
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'Automation/Monitors/decoy.json': radarFileBytes() });
    await expect(readRadar(store)).resolves.toMatchObject({ code: 'not-found', retryable: false });
  });

  it('invalid JSON and a wrong envelope are typed invalid errors, never a throw', async () => {
    for (const raw of [
      'not json at all',
      JSON.stringify(radarFile({ schema: 2 })),
      JSON.stringify(radarFile({ total: 'many' })),
      JSON.stringify(radarFile({ inFlight: [{ title: 'x', file: 'y', status: null, stage: 'dreaming', updated: null, daysSinceUpdate: null }] })),
      JSON.stringify(radarFile({ followUps: [{ title: 'x', stage: 'applied', due: '14-10-2026', field: 'follow_up', overdue: true }] })),
      JSON.stringify({ ...radarFile(), extra: true }),
    ]) {
      const store = await InMemoryStore.create({ [JOB_RADAR_PATH]: raw });
      await expect(readRadar(store)).resolves.toMatchObject({ code: 'invalid', retryable: false });
    }
  });

  it('a store outage is a retryable upstream-unavailable, never a throw', async () => {
    const down = {
      head: async () => { throw new StoreUnavailable('down'); },
      listFiles: async () => [],
      readFile: async () => null,
    } as unknown as VaultStore;
    await expect(readRadar(down)).resolves.toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });
});
