import { Command, MAX_NOTE_BYTES, TriageResponse } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createCommandService, triageDecidePlan } from './commands.ts';
import { canWrite, parseVaultPath } from './paths.ts';
import { FileTooLarge, type VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';
import { appendDecisionLine, parseDecisionLines, parseTriageApplied, parseTriageFeed, type DecisionLine } from './triage-format.ts';
import { createTriageService, triageDecisionPath } from './triage.ts';

const card = { eventId: '0a1b2c3d4e5f60718293', rank: 1, explore: false, resurfaced: false, title: 'Evening talk on city gardens',
  start: '2026-09-29T17:00:00+02:00', end: null, location: 'Community hall', online: false, cost: 'Free',
  registration: { state: 'open', deadline: '2026-09-28T23:59:00+02:00' }, aiScore: 88, why: 'Hands-on and close by.',
  category: 'community', scouts: ['city-events'], sourceName: 'Example source', sourceUrl: 'https://example.org/e1',
  calendar: { inCalendar: 'auto', clash: { title: 'Gym class', start: '2026-09-29T17:30:00+02:00', end: '2026-09-29T18:30:00+02:00' }, freeThatEvening: false } };
const NOW = '2026-09-30T22:30:00Z';
const ID = '00000000-0000-4000-8000-000000000024';
const payload = { eventId: card.eventId, decision: 'go' as const, reason: null, undoes: null, explore: false,
  card: { title: card.title, category: card.category, sourceName: card.sourceName, aiScore: card.aiScore, start: card.start } };
const line: DecisionLine = { schemaVersion: 1, decisionId: ID, at: NOW, ...payload };
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
const feed = (cards: unknown[] = [card]) => JSON.stringify({ schemaVersion: 1, generatedAt: NOW, cards });
const path = 'Events/Triage/Decisions/2026-10.jsonl';
const command = (baseRevision: string, occurredAt = NOW) => Command.parse({ schemaVersion: 1, type: 'TriageDecide', operationId: ID, occurredAt, baseRevision, payload });
const service = (store: InMemoryStore) => createCommandService({ store, now: () => new Date(NOW), timeZone: 'America/New_York' });
const read = async (store: InMemoryStore) => TriageResponse.parse(await createTriageService({ store, now: () => new Date(NOW) }).readTriage());

describe('triage JSON kernel goldens', () => {
  const golden = '{"schemaVersion":1,"decisionId":"00000000-0000-4000-8000-000000000024","eventId":"0a1b2c3d4e5f60718293","decision":"go","reason":null,"undoes":null,"explore":false,"at":"2026-09-30T22:30:00Z","card":{"title":"Evening talk on city gardens","category":"community","sourceName":"Example source","aiScore":88,"start":"2026-09-29T17:00:00+02:00"}}\n';
  it.each([null, '', '\uFEFFnot json\r\n  {"old":"ø 🌱"}\r\n', 'unterminated'])('preserves exact prefix and emits exactly one ordered LF line (%j)', (prefix) => {
    const result = appendDecisionLine(prefix, line);
    const before = new TextEncoder().encode(prefix ?? '');
    expect(result.slice(0, before.length)).toEqual(before);
    expect(result).toEqual(new TextEncoder().encode((prefix ?? '') + (prefix && !prefix.endsWith('\n') ? '\n' : '') + golden));
  });
  it('skips malformed, wrong-schema and invalid decision lines', () => {
    expect(parseDecisionLines('bad\n{}\n' + golden + JSON.stringify({ ...line, decision: 'undo', undoes: null }) + '\n' + JSON.stringify({ ...line, schemaVersion: 2 }))).toEqual([line]);
  });
  it('drops and counts invalid cards; strips nested unknown fields; accepts nullable end, clash and deadline', () => {
    const parsed = parseTriageFeed(feed([card, { ...card, extra: true, registration: { ...card.registration, extra: true } },
      { ...card, calendar: { ...card.calendar, inCalendar: 'own', clash: null }, registration: { state: 'unknown', deadline: null } },
      { ...card, registration: { state: 'closed', deadline: null } }, { ...card, aiScore: 101 }]));
    expect(parsed).toMatchObject({ feedState: 'ok', droppedCards: 2 });
    expect(parsed.cards).toHaveLength(3);
    expect(parsed.cards[1]).toEqual(card);
    expect(parseTriageFeed(null).feedState).toBe('absent');
    for (const bad of ['{', '{}', feed().replace('"schemaVersion":1', '"schemaVersion":2')]) expect(parseTriageFeed(bad).feedState).toBe('unreadable');
  });
  it('tolerates bad applied entries without losing valid entries or updatedAt', () => {
    expect(parseTriageApplied(JSON.stringify({ schemaVersion: 1, updatedAt: NOW, decisions: {
      [ID]: { status: 'applied', at: NOW, message: 'ok', extra: true }, bad: { status: 'failed' },
    }, problems: [] }))).toEqual({ appliedUpdatedAt: NOW, applied: { [ID]: { status: 'applied', at: NOW, message: 'ok' } } });
    expect(parseTriageApplied('{')).toEqual({ applied: {}, appliedUpdatedAt: null });
  });
});

describe('triage reads and path guards', () => {
  it('reads exactly current and previous month at one immutable head, with server now', async () => {
    const store = await InMemoryStore.create({ 'Events/Triage/feed.json': feed(),
      'Events/Triage/applied.json': JSON.stringify({ schemaVersion: 1, updatedAt: NOW, decisions: {}, problems: [] }),
      [path]: text(appendDecisionLine(null, line)), 'Events/Triage/Decisions/2026-09.jsonl': text(appendDecisionLine(null, { ...line, decisionId: ID.replace('024', '025') })),
      'Events/Triage/Decisions/2026-08.jsonl': text(appendDecisionLine(null, line)) });
    const pinned = store.headCommit;
    store.afterHead = async () => { store.afterHead = null; await store.commitFiles({ 'Events/Triage/feed.json': 'bad' }); };
    const files = vi.spyOn(store, 'readFile');
    const result = await read(store);
    expect(result).toMatchObject({ revision: pinned, now: new Date(NOW).toISOString(), feedState: 'ok', cards: [card], appliedUpdatedAt: NOW });
    expect(result.decisions.map((d) => d.decisionId)).toEqual([ID.replace('024', '025'), ID]);
    expect(store.calls.filter((c) => c === 'head')).toHaveLength(1);
    expect(files.mock.calls.map(([p, at]) => [p, at])).toEqual(expect.arrayContaining([[path, pinned]]));
    expect(files.mock.calls.every(([, at]) => at === pinned)).toBe(true);
    expect(files.mock.calls.some(([p]) => p.endsWith('2026-08.jsonl'))).toBe(false);
  });
  it('never reads an unlisted symlink or a mismatched blob', async () => {
    const store = await InMemoryStore.create({ 'Events/Triage/feed.json': feed() });
    const reads = vi.spyOn(store, 'readFile');
    vi.spyOn(store, 'listFiles').mockResolvedValue([]);
    expect((await read(store)).feedState).toBe('absent');
    expect(reads).not.toHaveBeenCalled();
    vi.mocked(store.listFiles).mockResolvedValue([{ path: 'Events/Triage/feed.json', blobSha: 'f'.repeat(40) }]);
    expect((await read(store)).cards).toEqual([]);
  });
  it('tolerates missing, oversized and invalid UTF-8 files independently', async () => {
    expect((await read(await InMemoryStore.create({}))).feedState).toBe('absent');
    const store = await InMemoryStore.create({ 'Events/Triage/feed.json': 'x'.repeat(MAX_NOTE_BYTES + 1),
      'Events/Triage/applied.json': new Uint8Array([255]), [path]: text(appendDecisionLine(null, line)) });
    expect(await read(store)).toMatchObject({ feedState: 'unreadable', applied: {}, decisions: [{ decisionId: ID }] });
    const actual = store.readFile.bind(store);
    store.readFile = async (p, x) => p === path ? { bytes: new Uint8Array(MAX_NOTE_BYTES + 1), blobSha: (await actual(p, x))!.blobSha, commitSha: x } : actual(p, x);
    expect((await read(store)).decisions).toEqual([]);
    store.readFile = async () => { throw new FileTooLarge(); };
    expect((await read(store)).feedState).toBe('unreadable');
  });
  it('only allows valid month JSONL writes and the exact read paths', () => {
    for (const target of ['Events/Triage/feed.json', 'Events/Triage/applied.json']) {
      expect(parseVaultPath(target)).toBe(target);
      for (const kind of ['create', 'update'] as const) expect(canWrite(parseVaultPath(target)!, kind)).toBe(false);
    }
    for (const kind of ['create', 'update'] as const) expect(canWrite(parseVaultPath(path)!, kind)).toBe(true);
    for (const p of ['Events/Triage/no.json', path.replace('2026-10', '2026-13'), path.replace('2026-10', '2026-00'), path.replace('Decisions/', 'Decisions/../'), path + '/extra']) {
      expect(parseVaultPath(p)).toBeNull(); expect(canWrite(p as VaultPath, 'create')).toBe(false);
    }
    expect(triageDecisionPath('2026-12-31T23:01:00Z')).toBe('Events/Triage/Decisions/2027-01.jsonl');
    expect(triageDecisionPath('2026-09-30T21:59:59Z')).toBe('Events/Triage/Decisions/2026-09.jsonl');
    expect(triageDecisionPath('2026-09-30T22:00:00Z')).toBe(path);
  });
});

describe('triage command execution', () => {
  it('creates the Copenhagen month, retries exactly once via trailers, and writes an undo as a new line', async () => {
    const store = await InMemoryStore.create({}); const run = service(store); const cmd = command(store.headCommit);
    expect(await run.execute(cmd, cmd)).toMatchObject({ status: 'applied', path, effect: { kind: 'triage-decided', decisionId: ID } });
    const prefix = store.text(path)!;
    expect(await run.execute(cmd, cmd)).toMatchObject({ status: 'already-applied' });
    expect(store.text(path)).toBe(prefix);
    const undo = Command.parse({ ...cmd, operationId: ID.replace('024', '025'), payload: { ...payload, decision: 'undo', undoes: ID } });
    expect(await run.execute(undo, undo)).toMatchObject({ status: 'applied' });
    expect(store.text(path)!.startsWith(prefix)).toBe(true);
    expect(parseDecisionLines(store.text(path)).map((d) => d.decision)).toEqual(['go', 'undo']);
    expect(store.commitsWithOp(ID)).toHaveLength(1);
  });
  it('dedupes by decisionId even with no trailer and a fresh base; refuses a reused ID', async () => {
    const prefix = text(appendDecisionLine('malformed\r\n', line));
    const store = await InMemoryStore.create({ [path]: prefix }); const run = service(store); const cmd = command(store.headCommit);
    expect(await run.execute(cmd, cmd)).toMatchObject({ status: 'already-applied', effect: { decisionId: ID } });
    expect(store.calls).not.toContain('writeFile');
    expect(store.text(path)).toBe(prefix);
    const changed = Command.parse({ ...cmd, payload: { ...payload, decision: 'skip' } });
    expect(await run.execute(changed, changed)).toMatchObject({ code: 'operation-id-reused' });
    if (cmd.type !== 'TriageDecide') throw new Error('type');
    expect(await triageDecidePlan(cmd).compute(store, store.headCommit)).toMatchObject({ ok: false, code: 'dedupe-unknown' });
  });
  it('preserves prefix on a head move and unknown write outcome', async () => {
    const store = await InMemoryStore.create({ [path]: 'legacy without newline' }); const run = service(store); const cmd = command(store.headCommit);
    store.writeFaults.push('apply-then-unknown');
    expect(await run.execute(cmd, cmd)).toMatchObject({ status: 'already-applied' });
    expect(store.text(path)).toBe(text(appendDecisionLine('legacy without newline', line)));
    expect(store.commitsWithOp(ID)).toHaveLength(1);
  });
  it('refuses oversized and invalid UTF-8 append targets without writing', async () => {
    for (const [bytes, code] of [[new Uint8Array([255]), 'refused:encoding'], ['x'.repeat(MAX_NOTE_BYTES), 'refused:too-large']] as const) {
      const store = await InMemoryStore.create({ [path]: bytes }); const cmd = command(store.headCommit);
      expect(await service(store).execute(cmd, cmd)).toMatchObject({ code });
      expect(store.calls).not.toContain('writeFile');
    }
  });
});
