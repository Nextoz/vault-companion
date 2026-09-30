import { MAX_NOTE_BYTES, ResearchRadarDecideCommand, type Receipt } from '@vault-companion/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandService } from './commands.ts';
import { appendRadarDecisionLine, radarPaperId } from './research-radar-format.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const NOW = new Date('2026-09-30T12:00:00Z');
const AT = '2026-09-30T14:00:00+02:00';
const PATH = 'Research/Radar/Decisions/2026-09.jsonl';
const SOURCE = 'https://example.com/paper?utm_source=test';

let store: InMemoryStore;
let svc: ReturnType<typeof createCommandService>;
let base: string;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

async function make(over: { decision?: 'remove' | 'keep' | 'undo'; undoes?: string | null; title?: string; source?: string; occurredAt?: string } = {}) {
  const source = over.source ?? SOURCE;
  const paperId = (await radarPaperId(source))!;
  const operationId = uuid();
  const decision = over.decision ?? 'remove';
  const raw = {
    schemaVersion: 1,
    operationId,
    type: 'ResearchRadarDecide',
    occurredAt: over.occurredAt ?? AT,
    baseRevision: base,
    payload: {
      paperId,
      decision,
      undoes: decision === 'undo' ? (over.undoes ?? '99999999-9999-4999-8999-999999999999') : null,
      card: { title: over.title ?? 'Synthetic paper', source, topic: 'AI' },
    },
  };
  return { raw, command: ResearchRadarDecideCommand.parse(raw), paperId };
}

async function run(raw: unknown) {
  return svc.executeRadarDecide(ResearchRadarDecideCommand.parse(raw), raw);
}

const ok = (value: Receipt | { code: string }) => {
  if ('code' in value) throw new Error(`expected receipt, got ${value.code}`);
  return value;
};

beforeEach(async () => {
  n = 0;
  store = await InMemoryStore.create({});
  svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  base = store.headCommit;
});

describe('executeRadarDecide', () => {
  it('first decision appends the exact golden JSONL line with a text-free commit', async () => {
    const { raw, command, paperId } = await make();
    const receipt = ok(await run(raw));
    const line = {
      schemaVersion: 1 as const,
      decisionId: raw.operationId,
      paperId,
      decision: command.payload.decision,
      undoes: command.payload.undoes,
      at: command.occurredAt,
      card: command.payload.card,
    };
    expect(receipt).toMatchObject({ status: 'applied', path: PATH, effect: { kind: 'research-radar-decided', path: PATH, decisionId: raw.operationId } });
    expect(store.text(PATH)).toBe(new TextDecoder().decode(appendRadarDecisionLine(null, line)));
    expect(store.commitMessages().at(-1)).toBe('Vault Companion: research radar decision');
    expect(store.commitsWithOp(raw.operationId as string)).toHaveLength(1);
  });

  it('a duplicate retry returns already-applied and writes no second line', async () => {
    const { raw } = await make();
    const first = ok(await run(raw));
    const writes = store.writeCalls;
    const retry = ok(await run(raw));
    expect(retry).toMatchObject({ status: 'already-applied', commitSha: first.commitSha });
    expect(store.writeCalls).toBe(writes);
    expect(store.text(PATH)!.trim().split('\n')).toHaveLength(1);
  });

  it('two concurrent same-month writers both land and preserve each other', async () => {
    const a = await make();
    const b = await make({ title: 'Second synthetic paper' });
    const [ra, rb] = await Promise.all([run(a.raw), run(b.raw)]);
    expect(ok(ra).status).toBe('applied');
    expect(ok(rb).status).toBe('applied');
    expect(store.commitsWithOp(a.raw.operationId as string)).toHaveLength(1);
    expect(store.commitsWithOp(b.raw.operationId as string)).toHaveLength(1);
    expect(store.text(PATH)!.trim().split('\n')).toHaveLength(2);
  });

  it('re-plans after a desktop edit of the same file, preserving the existing bytes', async () => {
    const existing = '{"schemaVersion":1,"decisionId":"11111111-1111-4111-8111-111111111111","paperId":"0123456789abcdef0123","decision":"remove","undoes":null,"at":"2026-09-30T13:00:00+02:00","card":{"title":"Existing paper","source":"https://example.com/existing","topic":"AI"}}\n';
    store.afterHead = async () => {
      store.afterHead = null;
      await store.commitFiles({ [PATH]: existing });
    };
    const { raw } = await make();
    ok(await run(raw));
    expect(store.text(PATH)).toContain(existing);
    expect(store.text(PATH)).toContain(raw.operationId);
  });

  it('refuses a malformed JSONL log without overwriting it', async () => {
    store = await InMemoryStore.create({ [PATH]: 'not-json\n' });
    svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
    base = store.headCommit;
    const { raw } = await make();
    await expect(run(raw)).resolves.toMatchObject({ code: 'invalid' });
    expect(store.writeCalls).toBe(0);
    expect(store.text(PATH)).toBe('not-json\n');
  });

  it('refuses a decision file that is not valid UTF-8', async () => {
    store = await InMemoryStore.create({ [PATH]: new Uint8Array([0xff, 0xfe]) });
    svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
    base = store.headCommit;
    const { raw } = await make();
    await expect(run(raw)).resolves.toMatchObject({ code: 'refused:encoding' });
    expect(store.writeCalls).toBe(0);
  });

  it('rejects the same operation ID with a different payload', async () => {
    const { raw } = await make();
    ok(await run(raw));
    const writes = store.writeCalls;
    const changed = { ...raw, payload: { ...raw.payload, card: { ...raw.payload.card, title: 'Different payload' } } };
    await expect(run(changed)).resolves.toMatchObject({ code: 'operation-id-reused' });
    expect(store.writeCalls).toBe(writes);
  });

  it('refuses an Undo whose target is not in this log and writes nothing', async () => {
    const { raw } = await make({ decision: 'undo' });
    await expect(run(raw)).resolves.toMatchObject({ code: 'invalid' });
    expect(store.writeCalls).toBe(0);
  });

  it('writes a paper identity that must hash to the submitted source URL', async () => {
    const paperId = (await radarPaperId(SOURCE))!;
    const { raw } = await make();
    const bad = { ...raw, payload: { ...raw.payload, paperId: '0'.repeat(20) } };
    await expect(run(bad)).resolves.toMatchObject({ code: 'invalid' });
    expect(store.writeCalls).toBe(0);
    const good = await make();
    expect(good.paperId).toBe(paperId);
  });

  it('refuses a foreign-paper Undo naming another paper decision with zero additional writes', async () => {
    const sourceA = 'https://example.com/paper-a';
    const a = await make({ source: sourceA, title: 'Paper A' });
    ok(await run(a.raw));
    const writes = store.writeCalls;
    base = store.headCommit;
    const b = await make({ decision: 'undo', undoes: a.raw.operationId as string, source: 'https://example.com/paper-b', title: 'Paper B' });
    await expect(run(b.raw)).resolves.toMatchObject({ code: 'invalid' });
    expect(store.writeCalls).toBe(writes);
    expect(store.text(PATH)!.trim().split('\n')).toHaveLength(1);
  });

  it('refuses a malformed preexisting cross-paper Undo log without overwriting it', async () => {
    const paperA = (await radarPaperId('https://example.com/paper-a'))!;
    const paperB = (await radarPaperId('https://example.com/paper-b'))!;
    const target = '11111111-1111-4111-8111-111111111111';
    const bad = {
      schemaVersion: 1,
      decisionId: '22222222-2222-4222-8222-222222222222',
      paperId: paperB,
      decision: 'undo',
      undoes: target,
      at: '2026-09-30T13:00:00+02:00',
      card: { title: 'Paper B', source: 'https://example.com/paper-b', topic: 'AI' },
    };
    const existing = new TextDecoder().decode(appendRadarDecisionLine(null, {
      schemaVersion: 1,
      decisionId: target,
      paperId: paperA,
      decision: 'remove',
      undoes: null,
      at: '2026-09-30T12:00:00+02:00',
      card: { title: 'Paper A', source: 'https://example.com/paper-a', topic: 'AI' },
    })) + JSON.stringify(bad) + '\n';
    store = await InMemoryStore.create({ [PATH]: existing });
    svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
    base = store.headCommit;
    const { raw } = await make();
    await expect(run(raw)).resolves.toMatchObject({ code: 'invalid' });
    expect(store.writeCalls).toBe(0);
    expect(store.text(PATH)).toBe(existing);
  });

  it('allows an October Undo of a September decision and appends only the current month', async () => {
    const targetId = '11111111-1111-4111-8111-111111111111';
    const paperId = (await radarPaperId(SOURCE))!;
    const september = new TextDecoder().decode(appendRadarDecisionLine(null, {
      schemaVersion: 1,
      decisionId: targetId,
      paperId,
      decision: 'keep',
      undoes: null,
      at: '2026-09-30T14:00:00+02:00',
      card: { title: 'Synthetic paper', source: SOURCE, topic: 'AI' },
    }));
    store = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-09.jsonl': september });
    svc = createCommandService({ store, now: () => new Date('2026-10-01T10:00:00Z'), timeZone: 'Europe/Copenhagen' });
    base = store.headCommit;
    const { raw } = await make({ decision: 'undo', undoes: targetId, occurredAt: '2026-10-01T10:00:00+02:00' });
    const receipt = ok(await run(raw));
    expect(receipt.path).toBe('Research/Radar/Decisions/2026-10.jsonl');
    expect(store.text('Research/Radar/Decisions/2026-09.jsonl')).toBe(september);
    expect(store.text('Research/Radar/Decisions/2026-10.jsonl')).toContain(raw.operationId);
  });

  it('refuses a listed decision log missing at the pinned revision and writes nothing', async () => {
    const existing = new TextDecoder().decode(appendRadarDecisionLine(null, {
      schemaVersion: 1,
      decisionId: '11111111-1111-4111-8111-111111111111',
      paperId: '0123456789abcdef0123',
      decision: 'remove',
      undoes: null,
      at: '2026-09-30T10:00:00+02:00',
      card: { title: 'Existing paper', source: 'https://example.com/existing', topic: 'AI' },
    }));
    store = await InMemoryStore.create({ [PATH]: existing });
    const original = store.readFile.bind(store);
    vi.spyOn(store, 'readFile').mockImplementation(async (p, at) => (p as string) === PATH ? null : original(p, at));
    svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
    base = store.headCommit;
    const { raw } = await make();
    await expect(run(raw)).resolves.toMatchObject({ code: 'invalid' });
    expect(store.writeCalls).toBe(0);
  });

  it('refuses a listed decision log whose blob changed during the read and writes nothing', async () => {
    const existing = new TextDecoder().decode(appendRadarDecisionLine(null, {
      schemaVersion: 1,
      decisionId: '11111111-1111-4111-8111-111111111111',
      paperId: '0123456789abcdef0123',
      decision: 'remove',
      undoes: null,
      at: '2026-09-30T10:00:00+02:00',
      card: { title: 'Existing paper', source: 'https://example.com/existing', topic: 'AI' },
    }));
    store = await InMemoryStore.create({ [PATH]: existing });
    const original = store.readFile.bind(store);
    vi.spyOn(store, 'readFile').mockImplementation(async (p, at) => (p as string) === PATH
      ? { blobSha: 'f'.repeat(40), bytes: new TextEncoder().encode(existing), commitSha: at }
      : original(p, at));
    svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
    base = store.headCommit;
    const { raw } = await make();
    await expect(run(raw)).resolves.toMatchObject({ code: 'invalid' });
    expect(store.writeCalls).toBe(0);
  });

  it('refuses an oversized decision log and writes nothing', async () => {
    store = await InMemoryStore.create({ [PATH]: new Uint8Array(MAX_NOTE_BYTES + 1) });
    svc = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
    base = store.headCommit;
    const { raw } = await make();
    await expect(run(raw)).resolves.toMatchObject({ code: 'refused:too-large' });
    expect(store.writeCalls).toBe(0);
  });

  it('writes into the Copenhagen month even when USER_TIME_ZONE is elsewhere', async () => {
    store = await InMemoryStore.create({});
    svc = createCommandService({ store, now: () => new Date('2026-10-01T02:30:00Z'), timeZone: 'America/New_York' });
    base = store.headCommit;
    const { raw } = await make({ occurredAt: '2026-09-30T22:30:00-04:00' });
    const receipt = ok(await run(raw));
    expect(receipt.path).toBe('Research/Radar/Decisions/2026-10.jsonl');
  });
});
