/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as kernel from './learning.ts';
import * as textTools from './text.ts';
import * as scanTools from './scan.ts';

const kindsHeader = '| id | Name | Score means | Status |\n| --- | --- | --- | --- |\n| dictation | Dictation | accuracy | active |\n';
const logHeader = '| Date | Kind | Min | Score | Detail | Topic or source | Note |\n| --- | --- | --- | --- | --- | --- | --- |\n';
const old = '| 2026-09-30 | verbs | 10 | 5 | | school | |';
const unknown = '| bad-date | odd |';
const fixture = '\uFEFF---\nprivate: synthetic\n---\n## Kinds\n\n' + kindsHeader + '\n## Log\n' + logHeader + old + '\n' + unknown + '\n\n## Notes\nKeep  spaces \n';
const session: kernel.LearningSession = { kind: 'dictation', date: '2026-10-04', minutes: 15, score: 7, detail: 'acc 8, spell 7', topic: 'weather report', note: 'Easy | loop\nagain ' };
const line = '| 2026-10-04 | dictation | 15 | 7 | acc 8, spell 7 | weather report | Easy \\| loop again |';

it('inserts exactly one row at the end of the Log table and leaves all other bytes untouched', () => {
  const r = kernel.insertLearningRow(fixture, session);
  expect(r).toMatchObject({ ok: true, text: fixture.replace('\n\n## Notes', '\n' + line + '\n\n## Notes'), effect: { kind: 'learning', op: 'logged', lineText: line } });
  if (!r.ok) throw new Error(r.code);
  expect(r.text.replace(line + '\n', '')).toBe(fixture);
  const parsed = kernel.parseLearning(r.text);
  expect(parsed).toMatchObject({ ok: true, kinds: [{ id: 'dictation', name: 'Dictation', scoreMeans: 'accuracy', status: 'active' }], rows: [
    { date: '2026-09-30', kind: 'verbs' }, { date: '2026-10-04', kind: 'dictation', note: 'Easy | loop again' },
  ], unknownLines: [unknown] });
});

it('refuses an unknown kind and a missing/wrong/duplicate table', () => {
  expect(kernel.insertLearningRow(fixture, { ...session, kind: 'nope' })).toMatchObject({ code: 'refused:learning-kind-unknown' });
  expect(kernel.insertLearningRow('## Log\n' + logHeader + old + '\n', session)).toMatchObject({ code: 'refused:learning-table-missing' });
  expect(kernel.insertLearningRow('## Kinds\n' + kindsHeader + '\n## Log\n' + logHeader.replace('Min', 'Mins') + old, session)).toMatchObject({ code: 'refused:learning-table-missing' });
  expect(kernel.insertLearningRow(fixture + '\n## Log\n' + logHeader + old, session)).toMatchObject({ code: 'refused:learning-table-missing' });
});

it('keeps CRLF, BOM and final newline state when inserting', () => {
  const crlf = fixture.replaceAll('\n', '\r\n');
  const expected = fixture.replace('\n\n## Notes', '\n' + line + '\n\n## Notes').replaceAll('\n', '\r\n');
  expect(kernel.insertLearningRow(crlf, session)).toMatchObject({ text: expected });
});

it('parses the canonical paste line and refuses malformed variants', () => {
  const parsed = kernel.parseLearningPasteLine('LG | dictation | 2026-10-04 | min 15 | score 7 | acc 8 | spell 7 | verbs 6 | topic: weather report');
  expect(parsed).toEqual({ kind: 'dictation', date: '2026-10-04', minutes: 15, score: '7', detail: 'acc 8, spell 7, verbs 6', topic: 'weather report' });
  for (const bad of [
    'LG | dictation | 2026-10-04 | min 15 | score 7 | acc 8 | spell | topic: weather report',
    'LG | dictation | 2026-10-04 | min x | score 7 | topic: weather report',
    'LG | dictation | 2026-02-30 | min 15 | score 7 | topic: weather report',
    'LG | dictation | 2026-10-04 | min 15 | score 123456789 | topic: weather report',
  ]) expect(kernel.parseLearningPasteLine(bad)).toMatchObject({ code: 'refused:learning-paste-invalid' });
});

it('mutation kills the kind guard and the exact inverse guard', () => {
  const source = readFileSync(new URL('./learning.ts', import.meta.url), 'utf8');
  const mutant = (from: string, to: string): typeof kernel => {
    expect(source).toContain(from);
    const js = ts.transpileModule(source.replace(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    runInNewContext(js, { exports, require: (name: string) => name === './scan.ts' ? scanTools : textTools });
    return exports as typeof kernel;
  };
  const kindAssertion = (k: typeof kernel) => expect(k.insertLearningRow(fixture, { ...session, kind: 'nope' })).toMatchObject({ code: 'refused:learning-kind-unknown' });
  kindAssertion(kernel);
  expect(() => kindAssertion(mutant('!parsed.kinds.some((k) => k.id === session.kind)', 'false'))).toThrow();
  const effect: kernel.LearningEffect = { kind: 'learning', op: 'logged', lineText: line };
  const undoAssertion = (k: typeof kernel) => expect(k.undoLearning('changed', 'target', 'parent', effect)).toMatchObject({ code: 'refused:undo-expired' });
  undoAssertion(kernel);
  expect(() => undoAssertion(mutant('source !== target', 'false'))).toThrow();
});
