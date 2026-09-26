/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { EditChanges, LocatorInput } from './api.ts';
import * as fields from './fields.ts';
import * as sanitize from './sanitize.ts';
import * as todoList from './todo-list.ts';
import * as textTools from './text.ts';
import { editTask } from './index.ts';

const line = '- [ ] Water plants #todo';
const doc = (task: string) => `## Open\n\n${task}\n  child with 📅 2026-01-01\n\n## Done\n`;
const locator = (task: string): LocatorInput => ({ lineIndex: 2, lineText: task, occurrencesAtRead: 1, sameRevision: true });

function golden(before: string, after: string, changes: EditChanges) {
  expect(editTask(doc(before), locator(before), changes)).toEqual({
    ok: true, text: doc(after), effect: { kind: 'edited', beforeLineText: before, afterLineText: after },
  });
}

describe('EditTask exact-byte goldens', () => {
  it.each([
    ['due', '📅 2026-10-01', '📅 2026-10-02', '2026-10-02'],
    ['scheduled', '⏳ 2026-10-01', '⏳ 2026-10-02', '2026-10-02'],
    ['priority', '🔼', '⏫', 'high'],
  ] as const)('sets, replaces in place and removes %s', (kind, oldToken, token, value) => {
    golden(`${line} ➕ 2026-01-01 ^water`, `${line} ➕ 2026-01-01 ${token} ^water`, { [kind]: value });
    golden(`${line} ${oldToken} ➕ 2026-01-01 ^water`, `${line} ${token} ➕ 2026-01-01 ^water`, { [kind]: value });
    golden(`${line} ${oldToken} ➕ 2026-01-01 ^water`, `${line} ➕ 2026-01-01 ^water`, { [kind]: null });
  });

  it('keeps every tag/field in original order and the block ID when replacing the description', () => {
    const suffix = ' #todo #garden ⏳ 2026-09-28 🛫 2026-09-27 🔺 📅 2026-09-30 ➕ 2026-09-01 🔁 every week 🆔 abc ⛔ xyz 🏁 keep ^water';
    golden(`* [ ] Water [[Garden|plants]]${suffix}`, `* [ ] Water [[Garden|herbs]]${suffix}`, { text: 'Water [[Garden|herbs]]' });
  });

  it('edits recurring/on-completion tasks and multiple fields together', () => {
    golden(`${line} 🔁 every week 🏁 delete 📅 2026-01-01 🔽 ^water`,
      '- [ ] Water herbs #todo 🔁 every week 🏁 delete 📅 2026-10-01 ⏳ 2026-09-30 ^water',
      { text: 'Water herbs', due: '2026-10-01', scheduled: '2026-09-30', priority: null });
  });

  it('preserves field variation selectors, spacing, child lines, BOM, CRLF and no final newline', () => {
    const before = `${line}  📅️   2026-10-01 #garden ^water  `;
    const after = `${line}  📅️   2026-10-02 #garden ^water  `;
    const input = '\uFEFF' + doc(before).replaceAll('\n', '\r\n').slice(0, -2);
    const result = editTask(input, locator(before), { due: '2026-10-02' });
    expect(result).toMatchObject({ ok: true, text: '\uFEFF' + doc(after).replaceAll('\n', '\r\n').slice(0, -2) });
    if (result.ok) expect(new TextEncoder().encode(result.text)).toEqual(new TextEncoder().encode(input.replace(before, after)));
  });

  it('removes only one leading space and retains the rest', () => {
    golden(`${line}  📅 2026-10-01 #garden`, `${line}  #garden`, { due: null });
  });

  it('fills an empty description without consuming its first field', () => {
    golden('- [ ] #todo', line, { text: 'Water plants' });
  });

  it.each(['highest', 'high', 'medium', 'low', 'lowest'] as const)('sets priority %s', (priority) => {
    const emoji = { highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' }[priority];
    golden(line, `${line} ${emoji}`, { priority });
  });

  it('uses completion token position including trailing whitespace after the block ID', () => {
    golden(`${line} ^water\u00a0`, `${line} 📅 2026-10-01 ^water\u00a0`, { due: '2026-10-01' });
  });

  it('edits an open item in Done in place', () => {
    const input = `## Open\n\n## Done\n${line}`;
    expect(editTask(input, { ...locator(line), lineIndex: 3 }, { text: 'Water herbs' }))
      .toMatchObject({ ok: true, text: '## Open\n\n## Done\n- [ ] Water herbs #todo' });
  });
});

// Run a copy of the actual production module with one guard removed. The refusal assertion must distinguish
// it from production. No source files are changed, and every import uses the real kernel implementation.
const source = readFileSync(new URL('./mutations.ts', import.meta.url), 'utf8');
function mutant(guard: string): typeof editTask {
  const editStart = source.indexOf('export function editTask(');
  const editEnd = source.indexOf('export function completeTask(', editStart);
  const edit = source.slice(editStart, editEnd);
  expect(edit.split(guard)).toHaveLength(2);
  const changed = source.slice(0, editStart) + edit.replace(guard, '{}') + source.slice(editEnd);
  const js = ts.transpileModule(changed, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const modules: Record<string, unknown> = { './fields.ts': fields, './sanitize.ts': sanitize, './todo-list.ts': todoList, './text.ts': textTools };
  const exports: Record<string, unknown> = {};
  runInNewContext(js, { exports, require: (path: string) => {
    if (!(path in modules)) throw new Error(`unexpected module ${path}`);
    return modules[path];
  } });
  return exports.editTask as typeof editTask;
}

const roundTrip = "return invalid('The edited line must preserve its description, tags and unrequested fields.');";
const readOnly = "return refuse(t.parsed.readOnlyReason, 'The app does not edit this kind of task.');";
const refusals: { name: string; task: string; changes: EditChanges; code: string; guard: string; input?: string }[] = [
  { name: 'done', task: line.replace('[ ]', '[x]'), changes: { text: 'New' }, code: 'refused:already-completed', guard: "return refuse('refused:already-completed', 'The task is already completed.');" },
  { name: 'cancelled', task: line.replace('[ ]', '[X]') + ' ❌ 2026-09-01', changes: { text: 'New' }, code: 'refused:already-completed', guard: "return refuse('refused:already-completed', 'The task is already completed.');" },
  { name: 'duplicate field', task: line + ' 📅 2026-01-01 📅 2026-01-02', changes: { text: 'New' }, code: 'refused:duplicate-field', guard: readOnly },
  { name: 'unsupported status', task: line.replace('[ ]', '[/]'), changes: { text: 'New' }, code: 'refused:unsupported-status', guard: readOnly },
  { name: 'date swallowed from text', task: line, changes: { text: 'New 📅 2026-01-01' }, code: 'refused:invalid-edit', guard: roundTrip },
  { name: 'tag swallowed from text', task: line, changes: { text: 'New #garden' }, code: 'refused:invalid-edit', guard: roundTrip },
  { name: 'removing embedded #todo', task: '- [ ] Water #todo plants', changes: { text: 'Water plants' }, code: 'refused:invalid-edit', guard: roundTrip },
  { name: 'removing another embedded tag', task: '- [ ] Water #garden plants #todo', changes: { text: 'Water plants' }, code: 'refused:invalid-edit', guard: roundTrip },
  { name: 'nothing to change', task: line, changes: { text: 'Water plants' }, code: 'refused:invalid-edit', guard: "if (line === t.lineText) return invalid('nothing to change');" },
  { name: 'absent field removal', task: line, changes: { due: null }, code: 'refused:invalid-edit', guard: "if (line === t.lineText) return invalid('nothing to change');" },
  { name: 'conflict markers', task: line, changes: { text: 'New' }, code: 'refused:vault-conflict', input: doc(line) + '<<<<<<< HEAD\n', guard: 'if (a.writeBlock) return a.writeBlock;' },
  { name: 'missing Done', task: line, changes: { text: 'New' }, code: 'refused:structure', input: doc(line).replace('## Done', '## Later'), guard: 'if (a.writeBlock) return a.writeBlock;' },
  { name: 'overlong text', task: line, changes: { text: 'a'.repeat(2001) }, code: 'refused:invalid-edit', guard: "return invalid('Text must be 1–2000 characters on a single line.');" },
  { name: 'control character', task: line, changes: { text: 'New\u0001text' }, code: 'refused:invalid-edit', guard: "return invalid('Text must be 1–2000 characters on a single line.');" },
  { name: 'malformed date', task: line, changes: { due: 'tomorrow' }, code: 'refused:invalid-edit', guard: "return invalid('Dates must be YYYY-MM-DD.');" },
  { name: 'unknown priority', task: line, changes: { priority: 'urgent' as EditChanges['priority'] }, code: 'refused:invalid-edit', guard: "return invalid('Unknown priority.');" },
  { name: 'empty change object', task: line, changes: {}, code: 'refused:invalid-edit', guard: "if (line === t.lineText) return invalid('nothing to change');" },
  { name: 'same field value', task: line + ' 📅 2026-10-01', changes: { due: '2026-10-01' }, code: 'refused:invalid-edit', guard: "if (line === t.lineText) return invalid('nothing to change');" },
];

describe('EditTask refusals, mutation checked', () => {
  it.each(refusals)('$name', ({ task, changes, code, guard, input = doc(task) }) => {
    const expected = { ok: false, code };
    expect(editTask(input, locator(task), changes)).toMatchObject(expected);
    // Removing some guards leads to a later, different refusal; matching messages also proves the intended guard ran.
    const original = editTask(input, locator(task), changes);
    expect(mutant(guard)(input, locator(task), changes)).not.toEqual(original);
  });

  it('uses exact locator conflict handling after a desktop edit', () => {
    expect(editTask(doc(line + ' #garden'), locator(line), { text: 'New' })).toMatchObject({ ok: false, code: 'conflict:task-changed' });
  });
});
