// Property tests over generated To-Do documents (review R1/A1, R2/A5, R6). Seeded, so every run checks the same
// corpus; a failure message carries the document index to reproduce it. All text is synthetic.
//   P1  exactUndo(complete(d)) === d, or the exact inverse declines (never a wrong result).
//   P2  complete / undo / capture never throw (reachable inputs get typed refusals).
//   P3  a successful semantic Undo keeps every task and every task's block length of d.
import { describe, expect, it } from 'vitest';
import type { CompleteEffect, MutationOk, ParsedTask, Refusal } from './api.ts';
import { captureTask, completeTask, exactUndo, undoCompleteTask } from './mutations.ts';
import { parseTodoList } from './todo-list.ts';

const DOCUMENTS = 4000;
const SEED = 0x5eed_2609;
const D = '2026-09-25';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(rnd: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const chance = (p: number) => rnd() < p;
  let k = 0;
  const openTasks: string[] = [];
  const task = (): string => {
    const line = `- [ ] T${k++} #todo${chance(0.2) ? ` ^b${k}` : ''}${chance(0.1) ? ' ' : ''}`;
    openTasks.push(line);
    return line;
  };
  const openItem = (): string[] =>
    pick<() => string[]>([
      () => [task()],
      () => [task()],
      () => [task(), '    - child'],
      () => [task(), '    - [ ] sub #todo', '', '        deeper'],
      () => (openTasks.length > 0 ? [pick(openTasks)] : [task()]),
      () => [''],
      () => [''],
      () => ['Some prose.'],
      () => ['- plain item'],
      () => ['    indented stray'],
      () => ['```', '- [ ] F #todo', '```'],
      () => ['%% hidden %%'],
      () => ['### Later'],
    ])();
  const doneItem = (): string[] =>
    pick<() => string[]>([
      () => [`- [x] X${k++} #todo ✅ 2026-09-01`],
      () => [`- [x] X${k++} #todo ✅ 2026-09-01`, '    - note'],
      () => [`- [ ] I${k++} #todo`],
      () => [''],
      () => ['Archive notes.'],
      () => ['```'],
      () => ['%% open comment'],
    ])();
  const body = (item: () => string[], max: number): string[] => {
    const out: string[] = [];
    const n = Math.floor(rnd() * (max + 1));
    for (let j = 0; j < n; j++) out.push(...item());
    return out;
  };
  const open = ['## Open', ...body(openItem, 6)];
  const done = ['## Done', ...(chance(0.3) ? body(doneItem, 3) : [])];
  const lines = [
    ...(chance(0.5) ? ['# List', ...(chance(0.5) ? [''] : [])] : []),
    ...(chance(0.5) ? [...open, ...done] : [...done, ...open]),
    ...(chance(0.2) ? ['## Notes', 'Nothing.'] : []),
  ];
  const eol = chance(0.5) ? '\n' : '\r\n';
  return (chance(0.2) ? '﻿' : '') + lines.join(eol) + (chance(0.7) ? eol : '');
}

const blocks = (tasks: readonly ParsedTask[]): string[] => tasks.map((t) => `${t.lineText}|${t.blockLineCount}`).sort();

function tasksOf(text: string): readonly ParsedTask[] {
  const p = parseTodoList(text);
  if (!p.ok) throw new Error(p.code);
  return p.tasks;
}

describe('kernel properties over generated documents', () => {
  it(`P1–P3 over ${DOCUMENTS} seeded documents`, () => {
    const rnd = mulberry32(SEED);
    const stats = { completions: 0, doneAbove: 0, exactAccepted: 0, exactDeclined: 0, semanticOk: 0, semanticRefused: 0, refusals: 0 };
    for (let i = 0; i < DOCUMENTS; i++) {
      const d = generate(rnd);
      const where = `document #${i}: ${JSON.stringify(d)}`;
      const parsed = parseTodoList(d);
      if (!parsed.ok) throw new Error(`${where} does not parse`);
      expect(() => captureTask(d, { text: 'Captured', createdDate: D }), where).not.toThrow();
      for (const t of parsed.tasks) {
        if (t.status !== 'open' || t.readOnlyReason) continue;
        const loc = { lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrences, sameRevision: true };
        let done: MutationOk<CompleteEffect> | Refusal;
        try {
          done = completeTask(d, loc, D);
        } catch (e) {
          throw new Error(`P2 complete threw on ${where} task ${t.lineText}: ${String(e)}`);
        }
        if (!done.ok) {
          stats.refusals++;
          continue;
        }
        stats.completions++;
        if (d.replace(/^﻿/, '').indexOf('## Done') < d.replace(/^﻿/, '').indexOf('## Open')) stats.doneAbove++;
        const effect = done.effect;
        const tag = `${where} task ${JSON.stringify(t.lineText)}`;

        const exact = exactUndo(done.text, effect);
        if (exact === null) stats.exactDeclined++;
        else {
          stats.exactAccepted++;
          expect(exact.text, `P1 ${tag}`).toBe(d);
        }
        const viaApi = undoCompleteTask(done.text, { completion: effect, unchangedSinceCompletion: true });
        if (exact !== null) expect(viaApi.ok && viaApi.text, `P1 via API ${tag}`).toBe(d);

        let semantic: MutationOk<{ openLineText: string }> | Refusal;
        try {
          semantic = undoCompleteTask(done.text, { completion: effect, unchangedSinceCompletion: false });
        } catch (e) {
          throw new Error(`P2 semantic undo threw on ${tag}: ${String(e)}`);
        }
        if (!semantic.ok) {
          stats.semanticRefused++;
          continue;
        }
        stats.semanticOk++;
        expect(blocks(tasksOf(semantic.text)), `P3 ${tag}`).toEqual(blocks(tasksOf(d)));
      }
    }
    // The generator must keep reaching the shapes the properties are about.
    expect(stats.completions).toBeGreaterThan(DOCUMENTS);
    expect(stats.doneAbove).toBeGreaterThan(DOCUMENTS / 4);
    expect(stats.exactAccepted).toBeGreaterThan(stats.completions * 0.9);
    expect(stats.semanticOk).toBeGreaterThan(stats.completions / 2);
    expect(stats.refusals).toBeGreaterThan(0);
    expect(stats.semanticRefused).toBeGreaterThan(0);
  });
});
