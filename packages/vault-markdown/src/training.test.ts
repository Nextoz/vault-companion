/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as kernel from './training.ts';
import * as textTools from './text.ts';
import * as scanTools from './scan.ts';

const header = '| Date | Time | Type | Distance | Duration | Weight | Split | Note |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
const today = '| 2026-09-28 | 19:00 | Gym | | 60 min | 82.4 kg | Bicep | |';
const legacy = '| 2026-09-26 | | Group workout | | | | | |\n| 2026-09-25 | 09:00 | Run | 5.2 km | 28 min | | | Legacy |';
const unknown = '| bad-date |  odd bytes  |';
const fixture = '\uFEFF---\nprivate: synthetic\n---\n## Sessions\n\n' + header + today + '\n' + unknown + '\n' + legacy + '\n\n## Week summaries\nKeep  spaces \nWorth keeping…\n';
const session: kernel.TrainingSession = { type: 'Run', when: '2026-09-28T18:00:00+02:00', distance: 5.2, duration: 28, note: ' Easy | loop\nagain ' };
const line = '| 2026-09-28 | 18:00 | Run | 5.2 km | 28 min | | | Easy \\| loop again |';

const todayRow: kernel.TrainingRow = { date: '2026-09-28', time: '19:00', type: 'Gym', distance: '', duration: '60 min', weight: '82.4 kg', split: 'Bicep', note: '' };
const editedToday = '| 2026-09-28 | 19:00 | Gym | | 75 min | 82.4 kg | Bicep | |';
const movedUp = '| 2026-09-30 | 19:00 | Gym | | 60 min | 82.4 kg | Bicep | |';
const movedDown = '| 2026-09-26 | 19:00 | Gym | | 60 min | 82.4 kg | Bicep | |';
const legacyRun = '| 2026-09-25 | 09:00 | Run | 5.2 km | 28 min | | | Legacy |';
const legacyRow: kernel.TrainingRow = { date: '2026-09-25', time: '09:00', type: 'Run', distance: '5.2 km', duration: '28 min', weight: '', split: '', note: 'Legacy' };
const editedLegacyRun = '| 2026-09-25 | 09:00 | Run | 5.2 km | 30 min | | | Legacy |';

it.each([
  ['backtick fence', '## Sessions\n```md\n' + header + '```'],
  ['tilde fence', '## Sessions\n~~~~~md\n' + header + '~~~~~'],
  ['fenced heading', '```\n## Sessions\n```\n' + header],
  ['indented table', '## Sessions\n' + header.split('\n').map((s) => '    ' + s).join('\n')],
  ['tab table', '## Sessions\n' + header.split('\n').map((s) => '\t' + s).join('\n')],
  ...['```', '~~~~', '```` trailing', '    ````', '\t````', '> ````'].map((close) => ['invalid closing fence ' + close, '## Sessions\n````\n' + close + '\n' + header]),
])('ignores code: %s', (_name, input) => {
  expect(kernel.insertTrainingRow(input!, session)).toMatchObject({ code: 'refused:training-table-missing' });
});
it('discovers a real table after a longer closing fence and ignores fenced section headings', () => {
  const input = '## Sessions\n   ~~~~md\n## Other\n' + header + '   ~~~~~ \t\n' + header;
  expect(kernel.insertTrainingRow(input, session)).toMatchObject({ text: input + line + '\n' });
});
it('refuses adjacent headers in one contiguous pipe block', () => {
  expect(kernel.insertTrainingRow('## Sessions\n' + header + today + '\n' + header + today, session)).toMatchObject({ code: 'refused:training-table-missing' });
});
it.each([
  header.replace('Note |', 'Note X'), header.slice(1),
  header.replace('\n| ---', '\nX ---'), header.replace(/\|\n$/, 'X\n'),
])('refuses malformed outer pipes %#', (input) => {
  expect(kernel.insertTrainingRow('## Sessions\n' + input, session)).toMatchObject({ code: 'refused:training-table-missing' });
});
it('keeps a session row without its closing pipe unknown and unchanged', () => {
  const odd = today.slice(0, -1);
  const input = '## Sessions\n' + header + odd + '\n';
  expect(kernel.parseTraining(input)).toMatchObject({ rows: [], unknownLines: [odd] });
  expect(kernel.insertTrainingRow(input, session)).toMatchObject({ text: input + line + '\n' });
});

it('inserts in date/time order, keeping legacy, unknown and outside bytes exactly', () => {
  const r = kernel.insertTrainingRow(fixture, session);
  expect(r).toMatchObject({ ok: true, text: fixture.replace(legacy, line + '\n' + legacy) });
  if (!r.ok) throw new Error(r.code);
  expect(r.text.replace(line + '\n', '')).toBe(fixture);
  const parsed = kernel.parseTraining(r.text);
  expect(parsed).toMatchObject({ ok: true, unknownLines: [unknown], rows: [
    { type: 'Gym' }, { note: 'Easy | loop again' }, { type: 'Group workout', time: '' }, { distance: '5.2 km', duration: '28 min' },
  ] });
});
it('inserts at top and yesterday below all today rows', () => {
  const top = '| 2026-09-29 | 00:00 | Run | 5.2 km | 28 min | | | |';
  expect(kernel.insertTrainingRow(fixture, { ...session, when: '2026-09-28T22:00:00Z', note: '' })).toMatchObject({ text: fixture.replace(today, top + '\n' + today) });
  const yesterday = '| 2026-09-27 | 18:00 | Run | 5.2 km | 28 min | | | |';
  expect(kernel.insertTrainingRow(fixture, { ...session, when: '2026-09-27T18:00:00+02:00', note: '' })).toMatchObject({ text: fixture.replace(legacy, yesterday + '\n' + legacy) });
});
it('appends after table, preserves CRLF and absence of final newline', () => {
  const source = ('## Sessions\n' + header + today).replaceAll('\n', '\r\n');
  expect(kernel.insertTrainingRow(source, session)).toMatchObject({ text: source + '\r\n' + line });
  const full = fixture.replaceAll('\n', '\r\n');
  expect(kernel.insertTrainingRow(full, session)).toMatchObject({ text: fixture.replace(legacy, line + '\n' + legacy).replaceAll('\n', '\r\n') });
});
it('formats Gym, blank optional weight, backslash plus pipe and Copenhagen DST', () => {
  expect(kernel.formatTrainingRow({ type: 'Gym', split: 'Legs', duration: 60, when: '2026-01-01T23:00:00Z' })).toBe('| 2026-01-02 | 00:00 | Gym | | 60 min | | Legs | |');
  expect(kernel.formatTrainingRow({ type: 'Gym', split: 'Bicep', weight: 82.4, duration: 60, when: '2026-09-28T16:42:00Z' })).toBe('| 2026-09-28 | 18:42 | Gym | | 60 min | 82.4 kg | Bicep | |');
  const r = kernel.insertTrainingRow(fixture, { ...session, note: 'slash \\| pipe' });
  expect(r.ok && kernel.parseTraining(r.text)).toMatchObject({ rows: [{}, { note: 'slash \\| pipe' }, {}, {}] });
});
it('formats a Group class name and round-trips pipe/backslash escapes through parseTraining', () => {
  expect(kernel.formatTrainingRow({ type: 'Gym', split: 'Group', className: 'Functional Express', duration: 45, when: '2026-09-28T16:00:00Z' }))
    .toBe('| 2026-09-28 | 18:00 | Gym | | 45 min | | Group: Functional Express | |');
  const group: kernel.TrainingSession = { type: 'Gym', split: 'Group', className: 'A|B \\ C', duration: 45, when: '2026-09-28T16:00:00Z' };
  const r = kernel.insertTrainingRow(fixture, group);
  expect(r).toMatchObject({ ok: true, effect: { lineText: '| 2026-09-28 | 18:00 | Gym | | 45 min | | Group: A\\|B \\\\ C | |' } });
  if (!r.ok) throw new Error(r.code);
  expect(kernel.parseTraining(r.text)).toMatchObject({ rows: [{}, { split: 'Group: A|B \\ C' }, {}, {}] });
});
it.each([
  fixture.replace('## Sessions', '## Other'), '## Sessions\nNo table\n', fixture.replace('Distance', 'distance'),
  fixture.replace('## Week summaries', header + '\n## Week summaries'), fixture.replace('| --- |', '| xx |'),
])('refuses missing, wrong or ambiguous table %#', (source) => {
  expect(kernel.insertTrainingRow(source, session)).toMatchObject({ ok: false, code: 'refused:training-table-missing' });
});
it('invalid calendar dates, time and cell counts are unknown and never moved', () => {
  const odd = '| 2026-02-30 | | Run | | | | | |\n| 2026-09-28 | 25:00 | Gym | | | | | |\n| only | two |';
  expect(kernel.parseTraining('## Sessions\n' + header + odd)).toMatchObject({ rows: [], unknownLines: odd.split('\n') });
});
it('exact inverse refuses any intervening byte change', () => {
  const r = kernel.insertTrainingRow(fixture, session);
  if (!r.ok) throw new Error(r.code);
  expect(kernel.undoTraining(r.text, r.text, fixture, r.effect)).toMatchObject({ text: fixture, effect: { op: 'undone' } });
  expect(kernel.undoTraining(r.text + ' ', r.text, fixture, r.effect)).toMatchObject({ code: 'refused:undo-expired' });
});

it('edits a row in place when the date/time is unchanged, keeping every other byte', () => {
  const r = kernel.editTrainingRow(fixture, todayRow, { type: 'Gym', split: 'Bicep', weight: 82.4, duration: 75, when: '2026-09-28T17:00:00Z' });
  expect(r).toMatchObject({ ok: true, effect: { kind: 'training', op: 'edited', lineText: editedToday }, text: fixture.replace(today, editedToday) });
  if (!r.ok) throw new Error(r.code);
  expect(r.text.replace(editedToday, today)).toBe(fixture);
  expect(r.text).toContain(unknown); expect(r.text).toContain(legacy);
});
it('a date change moves the row up when newer and down when older', () => {
  const sorted = '## Sessions\n' + header + '| 2026-09-29 | 09:00 | Run | 5.2 km | 28 min | | | |\n' + today + '\n' + '| 2026-09-27 | 08:00 | Run | 5.2 km | 28 min | | | |\n';
  const up = kernel.editTrainingRow(sorted, todayRow, { type: 'Gym', split: 'Bicep', weight: 82.4, duration: 60, when: '2026-09-30T17:00:00Z' });
  expect(up).toMatchObject({ ok: true, effect: { lineText: movedUp }, text: sorted.replace(today + '\n', '').replace('| 2026-09-29 | 09:00 | Run | 5.2 km | 28 min | | | |', movedUp + '\n' + '| 2026-09-29 | 09:00 | Run | 5.2 km | 28 min | | | |') });
  const down = kernel.editTrainingRow(sorted, todayRow, { type: 'Gym', split: 'Bicep', weight: 82.4, duration: 60, when: '2026-09-26T17:00:00Z' });
  expect(down).toMatchObject({ ok: true, effect: { lineText: movedDown }, text: sorted.replace(today + '\n', '') + movedDown + '\n' });
});
it('keeps CRLF, BOM and the absence of a final newline when editing', () => {
  const source = ('## Sessions\n' + header + today).replaceAll('\n', '\r\n');
  expect(kernel.editTrainingRow(source, todayRow, { type: 'Gym', split: 'Bicep', weight: 82.4, duration: 75, when: '2026-09-28T17:00:00Z' })).toMatchObject({ text: source.replace(today, editedToday) });
  const full = fixture.replaceAll('\n', '\r\n');
  expect(kernel.editTrainingRow(full, todayRow, { type: 'Gym', split: 'Bicep', weight: 82.4, duration: 75, when: '2026-09-28T17:00:00Z' })).toMatchObject({ text: fixture.replace(today, editedToday).replaceAll('\n', '\r\n') });
});
it('edits a legacy row and leaves unknown and neighbouring legacy bytes untouched', () => {
  const r = kernel.editTrainingRow(fixture, legacyRow, { type: 'Run', when: '2026-09-25T07:00:00Z', distance: 5.2, duration: 30, note: 'Legacy' });
  expect(r).toMatchObject({ ok: true, effect: { lineText: editedLegacyRun }, text: fixture.replace(legacyRun, editedLegacyRun) });
  if (!r.ok) throw new Error(r.code);
  expect(r.text).toContain(unknown); expect(r.text).toContain(today); expect(r.text).toContain('| 2026-09-26 | | Group workout | | | | | |');
});
it('refuses a row that changed, ambiguous duplicates, no-op edits and missing tables', () => {
  expect(kernel.editTrainingRow(fixture, { ...todayRow, note: 'x' }, session)).toMatchObject({ code: 'conflict:training-changed' });
  expect(kernel.editTrainingRow('## Sessions\n' + header + today + '\n' + today + '\n', todayRow, { type: 'Gym', split: 'Bicep', weight: 82.4, duration: 75, when: '2026-09-28T17:00:00Z' })).toMatchObject({ code: 'conflict:ambiguous' });
  expect(kernel.editTrainingRow(fixture, todayRow, { type: 'Gym', split: 'Bicep', weight: 82.4, duration: 60, when: '2026-09-28T17:00:00Z' })).toMatchObject({ code: 'refused:invalid-edit' });
  expect(kernel.editTrainingRow('## Sessions\nNo table\n', todayRow, session)).toMatchObject({ code: 'refused:training-table-missing' });
});

it('mutation kills the edit row-match guard', () => {
  const assertion = (k: typeof kernel) => expect(k.editTrainingRow(fixture, { ...todayRow, note: 'x' }, session)).toMatchObject({ code: 'conflict:training-changed' });
  assertion(kernel);
  expect(() => assertion(mutant('matches.length === 0', 'false'))).toThrow();
});

const source = readFileSync(new URL('./training.ts', import.meta.url), 'utf8');
function mutant(from: string, to: string): typeof kernel {
  expect(source).toContain(from);
  const js = ts.transpileModule(source.replace(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  runInNewContext(js, { exports, require: (name: string) => name === './scan.ts' ? scanTools : textTools });
  return exports as typeof kernel;
}
it.each([
  ['two tables', 'tables.length !== 1', 'tables.length === 0', fixture.replace('## Week summaries', header + '\n## Week summaries')],
  ['wrong header', 'JSON.stringify(cells(doc.lines[header]!)) !== JSON.stringify(cells(TRAINING_HEADER))', 'false', fixture.replace('Distance', 'distance')],
  ['duplicate heading', 'headings.length !== 1', 'headings.length === 0', fixture + '\n## Sessions\n'],
] as const)('mutation kills %s refusal', (_name, from, to, input) => {
  const assertion = (k: typeof kernel) => expect(k.insertTrainingRow(input, session)).toMatchObject({ code: 'refused:training-table-missing' });
  assertion(kernel);
  expect(() => assertion(mutant(from, to))).toThrow();
});
it('mutation kills exact inverse guard removal', () => {
  const effect: kernel.TrainingEffect = { kind: 'training', op: 'logged', lineText: line };
  const assertion = (k: typeof kernel) => expect(k.undoTraining('changed', 'target', 'parent', effect)).toMatchObject({ code: 'refused:undo-expired' });
  assertion(kernel);
  expect(() => assertion(mutant('source !== target', 'false'))).toThrow();
});
it('mutation kills pipe escaping removal', () => {
  const assertion = (k: typeof kernel) => expect(k.insertTrainingRow(fixture, session)).toMatchObject({ text: fixture.replace(legacy, line + '\n' + legacy) });
  assertion(kernel);
  expect(() => assertion(mutant(".replaceAll('|', '\\\\|')", ''))).toThrow();
});

it('refuses a Group session without a class name instead of writing an empty one', () => {
  for (const className of [undefined, '', '   ']) {
    const r = kernel.insertTrainingRow(fixture, { type: 'Gym', split: 'Group', className, duration: 45, when: '2026-09-28T16:00:00Z' });
    expect(r).toMatchObject({ ok: false, code: 'refused:invalid-edit' });
  }
});
