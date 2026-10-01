import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { ResearchRadarDecideCommand, Receipt } from '@vault-companion/contracts';
import { createCommandService, createResearchRadarService, parseVaultPath, radarPaperId } from '@vault-companion/domain';
import { LocalGitStore } from '@vault-companion/github/local-git';
import { createApp } from '../../../apps/worker/src/app.ts';
import { createRemote, logWithOps, type RemoteFixture } from './git.ts';

const ORIGIN = 'https://vc.example.invalid';
const ACCOUNT = 'a'.repeat(64);
const NOW = '2026-09-30T10:00:00Z';
const AT = '2026-09-30T12:00:00+02:00';
const PATH = 'Research/Radar/Decisions/2026-09.jsonl';

let remote: RemoteFixture | undefined;

afterEach(() => {
  if (remote) rmSync(remote.root, { recursive: true, force: true });
  remote = undefined;
});

function makeHarness(seed: Readonly<Record<string, string>>, now = NOW) {
  remote = createRemote(seed);
  const saved = { ...process.env };
  let store: LocalGitStore;
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, remote.env);
    store = new LocalGitStore({ repo: remote.bare, author: { name: 'Vault Companion', email: 'vault-companion@example.invalid' } });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const deps = { store, now: () => new Date(now), timeZone: 'Europe/Copenhagen' };
  const logs: unknown[] = [];
  const app = createApp({
    appOrigin: ORIGIN,
    verify: async (token) => token === 'good'
      ? { ok: true, email: 'owner@example.invalid', accountKey: ACCOUNT }
      : { ok: false },
    services: { ...createCommandService(deps), ...createResearchRadarService(deps) },
    log: (record) => logs.push(record),
  });
  return { remote, store, app, logs };
}

async function command(source: string, baseRevision: string, over: { operationId?: string; decision?: 'remove' | 'keep' | 'undo'; undoes?: string | null; title?: string; occurredAt?: string } = {}) {
  const paperId = (await radarPaperId(source))!;
  const decision = over.decision ?? 'remove';
  return ResearchRadarDecideCommand.parse({
    schemaVersion: 1,
    operationId: over.operationId ?? randomUUID(),
    type: 'ResearchRadarDecide',
    occurredAt: over.occurredAt ?? AT,
    baseRevision,
    payload: {
      paperId,
      decision,
      undoes: decision === 'undo' ? (over.undoes ?? null) : null,
      card: { title: over.title ?? 'Synthetic Radar paper', source, topic: 'radar' },
    },
  });
}

async function post(app: ReturnType<typeof makeHarness>['app'], raw: unknown) {
  const response = await app.request('/api/radar/decisions', {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': 'good',
      Origin: ORIGIN,
      'X-VC-Request': '1',
      'X-VC-Account': ACCOUNT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(raw),
  });
  const body: unknown = await response.json();
  return response.ok ? Receipt.parse(body) : body;
}

it('appends golden bytes to an existing CRLF log, dedupes a retry, and appends Undo as a new line', async () => {
  const existing = {
    schemaVersion: 1,
    decisionId: '11111111-1111-4111-8111-111111111111',
    paperId: '0'.repeat(20),
    decision: 'remove',
    undoes: null,
    at: '2026-09-30T09:00:00+02:00',
    card: { title: 'Existing synthetic paper', source: 'https://example.com/existing', topic: 'ai' },
  };
  const prefix = `${JSON.stringify(existing)}\r\n`;
  const { remote: fixture, store, app } = makeHarness({ [PATH]: prefix });
  const base = (await store.head()).commitSha;
  const raw = await command('https://example.com/paper-b', base, { operationId: '22222222-2222-4222-8222-222222222222' });

  const first = await post(app, raw);
  expect(first).toMatchObject({ status: 'applied', path: PATH });

  let head = (await store.head()).commitSha;
  const bytes = (await store.readFile(parseVaultPath(PATH)!, head))!.bytes;
  const text = new TextDecoder().decode(bytes);
  expect(text.startsWith(prefix)).toBe(true);
  const appended = text.slice(prefix.length);
  expect(appended.endsWith('\n')).toBe(true);
  expect(appended.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(appended.trim())).toEqual({
    schemaVersion: 1,
    decisionId: raw.operationId,
    paperId: raw.payload.paperId,
    decision: raw.payload.decision,
    undoes: raw.payload.undoes,
    at: raw.occurredAt,
    card: raw.payload.card,
  });

  const retry = await post(app, raw);
  expect(retry).toMatchObject({ status: 'already-applied', commitSha: head });
  expect(logWithOps(fixture.env, fixture.bare).filter((c) => c.operationId === raw.operationId)).toHaveLength(1);

  head = (await store.head()).commitSha;
  const undo = await command('https://example.com/paper-b', head, { decision: 'undo', undoes: raw.operationId });
  expect(await post(app, undo)).toMatchObject({ status: 'applied' });
  const afterUndo = new TextDecoder().decode((await store.readFile(parseVaultPath(PATH)!, (await store.head()).commitSha))!.bytes);
  expect(afterUndo.trim().split('\n')).toHaveLength(3);
  expect(afterUndo).toContain(`"undoes":"${raw.operationId}"`);
  expect(logWithOps(fixture.env, fixture.bare).filter((c) => c.operationId === undo.operationId)).toHaveLength(1);
});

it('two concurrent same-month Radar writers both land exactly one line each in real Git', async () => {
  const { remote: fixture, store, app } = makeHarness({ 'README.md': 'synthetic\n' });
  const base = (await store.head()).commitSha;
  const [a, b] = await Promise.all([
    command('https://example.com/paper-a', base, { operationId: '33333333-3333-4333-8333-333333333333', title: 'Paper A' }),
    command('https://example.com/paper-b', base, { operationId: '44444444-4444-4444-8444-444444444444', title: 'Paper B' }),
  ]);
  const [ra, rb] = await Promise.all([post(app, a), post(app, b)]);
  expect(ra).toMatchObject({ status: 'applied', operationId: a.operationId });
  expect(rb).toMatchObject({ status: 'applied', operationId: b.operationId });
  const text = new TextDecoder().decode((await store.readFile(parseVaultPath(PATH)!, (await store.head()).commitSha))!.bytes);
  expect(text.trim().split('\n')).toHaveLength(2);
  expect(logWithOps(fixture.env, fixture.bare).filter((c) => c.operationId === a.operationId)).toHaveLength(1);
  expect(logWithOps(fixture.env, fixture.bare).filter((c) => c.operationId === b.operationId)).toHaveLength(1);
});

it('undoes a September decision in October, preserving the old file and appending only October', async () => {
  const source = 'https://example.com/month-boundary';
  const targetId = '55555555-5555-4555-8555-555555555555';
  const paperId = (await radarPaperId(source))!;
  const september = `${JSON.stringify({
    schemaVersion: 1,
    decisionId: targetId,
    paperId,
    decision: 'keep',
    undoes: null,
    at: '2026-09-30T12:00:00+02:00',
    card: { title: 'September paper', source, topic: 'radar' },
  })}\n`;
  const { store, app } = makeHarness({ [PATH]: september }, '2026-10-01T10:00:00Z');
  const base = (await store.head()).commitSha;
  const undo = await command(source, base, { decision: 'undo', undoes: targetId, occurredAt: '2026-10-01T10:00:00+02:00' });
  const result = await post(app, undo);
  expect(result).toMatchObject({ status: 'applied', path: 'Research/Radar/Decisions/2026-10.jsonl' });
  expect(new TextDecoder().decode((await store.readFile(parseVaultPath(PATH)!, (await store.head()).commitSha))!.bytes)).toBe(september);
  const october = new TextDecoder().decode((await store.readFile(parseVaultPath('Research/Radar/Decisions/2026-10.jsonl')!, (await store.head()).commitSha))!.bytes);
  expect(october.trim().split('\n')).toHaveLength(1);
  expect(october).toContain(undo.operationId);
});

it('refuses a foreign-paper Undo in real Git with no extra decision line', async () => {
  const { store, app } = makeHarness({ 'README.md': 'synthetic\n' });
  const a = await command('https://example.com/paper-a', (await store.head()).commitSha, { operationId: '66666666-6666-4666-8666-666666666666', title: 'Paper A' });
  expect(await post(app, a)).toMatchObject({ status: 'applied' });
  const before = new TextDecoder().decode((await store.readFile(parseVaultPath(PATH)!, (await store.head()).commitSha))!.bytes);
  const b = await command('https://example.com/paper-b', (await store.head()).commitSha, { decision: 'undo', undoes: a.operationId, title: 'Paper B' });
  expect(await post(app, b)).toMatchObject({ code: 'invalid' });
  expect(new TextDecoder().decode((await store.readFile(parseVaultPath(PATH)!, (await store.head()).commitSha))!.bytes)).toBe(before);
});
