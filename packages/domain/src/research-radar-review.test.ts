import { expect, it } from 'vitest';
import { ResearchRadarDecideCommand } from '@vault-companion/contracts';
import { createCommandService } from './commands.ts';
import { appendRadarDecisionLine, radarPaperId } from './research-radar-format.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const source = 'https://example.com/synthetic-review';
const target = '11111111-1111-4111-8111-111111111111';
const undo = '22222222-2222-4222-8222-222222222222';
const operation = '33333333-3333-4333-8333-333333333333';
const encode = (line: Parameters<typeof appendRadarDecisionLine>[1]) => new TextDecoder().decode(appendRadarDecisionLine(null, line));

it('Lead review: refuses an append exceeding the validated 5000-line history bound', async () => {
  const paperId = (await radarPaperId(source))!;
  const card = { title: 'Synthetic history limit', source, topic: 'AI' };
  const files: Record<string, string> = {};
  for (let monthIndex = 0; monthIndex < 5; monthIndex += 1) {
    const month = `2026-${String(monthIndex + 5).padStart(2, '0')}`;
    const rows = Array.from({ length: 1000 }, (_, i) => encode({
      schemaVersion: 1, decisionId: `${(monthIndex * 1000 + i).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
      paperId, decision: 'remove', undoes: null, at: `${month}-15T10:00:00Z`, card,
    }));
    files[`Research/Radar/Decisions/${month}.jsonl`] = rows.join('');
  }
  const store = await InMemoryStore.create(files);
  const svc = createCommandService({ store, now: () => new Date('2026-09-30T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
  const command = ResearchRadarDecideCommand.parse({ schemaVersion: 1, operationId: operation,
    type: 'ResearchRadarDecide', occurredAt: '2026-09-30T12:00:00Z', baseRevision: store.headCommit,
    payload: { paperId, decision: 'keep', undoes: null, card } });
  const before = store.text('Research/Radar/Decisions/2026-09.jsonl');
  const result = await svc.executeRadarDecide(command, command);
  expect(result).toMatchObject({ code: 'invalid' });
  expect(store.writeCalls).toBe(0);
  expect(store.text('Research/Radar/Decisions/2026-09.jsonl')).toBe(before);
});

it('Lead review: allows a prospective append that reaches exactly 5000 lines', async () => {
  const paperId = (await radarPaperId(source))!;
  const card = { title: 'Synthetic history limit', source, topic: 'AI' };
  const files: Record<string, string> = {};
  let idIndex = 0;
  for (let monthIndex = 0; monthIndex < 5; monthIndex += 1) {
    const month = `2026-${String(monthIndex + 5).padStart(2, '0')}`;
    const length = monthIndex === 4 ? 999 : 1000;
    const rows = Array.from({ length }, (_, i) => encode({
      schemaVersion: 1, decisionId: `${(idIndex + i).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
      paperId, decision: 'remove', undoes: null, at: `${month}-15T10:00:00Z`, card,
    }));
    files[`Research/Radar/Decisions/${month}.jsonl`] = rows.join('');
    idIndex += length;
  }
  const store = await InMemoryStore.create(files);
  const svc = createCommandService({ store, now: () => new Date('2026-09-30T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
  const command = ResearchRadarDecideCommand.parse({ schemaVersion: 1, operationId: operation,
    type: 'ResearchRadarDecide', occurredAt: '2026-09-30T12:00:00Z', baseRevision: store.headCommit,
    payload: { paperId, decision: 'keep', undoes: null, card } });
  const result = await svc.executeRadarDecide(command, command);
  expect(result).toMatchObject({ status: 'applied' });
  expect(store.writeCalls).toBe(1);
});

it('Lead review: refuses a second Undo targeting an already-undone decision without a write', async () => {
  const paperId = (await radarPaperId(source))!;
  const card = { title: 'Synthetic review', source, topic: 'AI' };
  const log = encode({ schemaVersion: 1, decisionId: target, paperId, decision: 'remove', undoes: null, at: '2026-09-30T10:00:00Z', card })
    + encode({ schemaVersion: 1, decisionId: undo, paperId, decision: 'undo', undoes: target, at: '2026-09-30T10:01:00Z', card });
  const store = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-09.jsonl': log });
  const svc = createCommandService({ store, now: () => new Date('2026-09-30T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
  const command = ResearchRadarDecideCommand.parse({ schemaVersion: 1, operationId: operation, type: 'ResearchRadarDecide', occurredAt: '2026-09-30T12:00:00Z', baseRevision: store.headCommit, payload: { paperId, decision: 'undo', undoes: target, card } });
  const result = await svc.executeRadarDecide(command, command);
  expect(result).toMatchObject({ code: 'invalid' });
  expect(store.writeCalls).toBe(0);
});

it('Lead review: a valid September Undo of August must not block unrelated October writes', async () => {
  const paperId = (await radarPaperId(source))!;
  const card = { title: 'Synthetic review', source, topic: 'AI' };
  const store = await InMemoryStore.create({
    'Research/Radar/Decisions/2026-08.jsonl': encode({ schemaVersion: 1, decisionId: target, paperId, decision: 'remove', undoes: null, at: '2026-08-31T10:00:00Z', card }),
    'Research/Radar/Decisions/2026-09.jsonl': encode({ schemaVersion: 1, decisionId: undo, paperId, decision: 'undo', undoes: target, at: '2026-09-01T10:00:00Z', card }),
  });
  const svc = createCommandService({ store, now: () => new Date('2026-10-01T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
  const command = ResearchRadarDecideCommand.parse({ schemaVersion: 1, operationId: operation, type: 'ResearchRadarDecide', occurredAt: '2026-10-01T12:00:00Z', baseRevision: store.headCommit, payload: { paperId, decision: 'keep', undoes: null, card } });
  const result = await svc.executeRadarDecide(command, command);
  expect(result).toMatchObject({ status: 'applied' });
});
