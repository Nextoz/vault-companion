import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as kernel from './active-work.ts';
import * as scan from './scan.ts';
import * as textTools from './text.ts';
import type { LocatorInput, MutationOk, Refusal } from './api.ts';

const fixture = readFileSync(new URL('./fixtures/active-work.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const garden = '- [ ] **Garden plan:** beds ready for spring. Next: order seed catalogue ⏳ 2026-10-03 [[Garden Plan]]';
const bike = '- [ ] **Bike repair:** commuting again. Next: call the shop ⏳ 2026-09-20 [[Bike]]';
const parked = '- Plain bullet parked idea without a checkbox. [[Ideas/Some Idea]]';
const dropped = '- 2026-09-18: an older prose entry about something stopped. [[Archive/Old]]';
const odd = '- [ ] A hand edited line, **not the item grammar**.';
const today = '2026-09-27';
function loc(text = fixture, lineText = bike): LocatorInput {
  return { lineIndex: text.replace(/^\uFEFF/, '').split(/\r?\n/).indexOf(lineText), lineText, occurrencesAtRead: 1, sameRevision: true };
}
function ok<E>(r: MutationOk<E> | Refusal): MutationOk<E> {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

describe('ADR-0019 exact goldens', () => {
  for (const eol of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) for (const final of [false, true]) {
    const encode = (text: string) => bom + text.replace(/\n$/, '').replaceAll('\n', eol) + (final ? eol : '');
    it(`refuses child-block splits, BOM=${!!bom}, EOL=${JSON.stringify(eol)}, final=${final}`, () => {
      const refused = (r: ReturnType<typeof kernel.captureActiveWork>) => {
        expect(r).toMatchObject({ ok: false, code: 'refused:structure' });
        expect('text' in r).toBe(false);
      };
      for (const child of ['  continuation', '  - child bullet', '\tcontinuation', '\n  - separated child']) {
        const source = encode(fixture.replace(bike, `${bike}\n${child}`));
        refused(kernel.captureActiveWork(source, { name: 'New' }));
        for (const action of ['park', 'done', 'drop'] as const) {
          refused(kernel.reviewActiveWork(source, loc(source), action, today, 'stopped'));
          const anchor = action === 'park' ? parked : dropped;
          const destination = encode(fixture.replace(anchor, `${anchor}\n${child}`));
          refused(kernel.reviewActiveWork(destination, loc(destination), action, today, 'stopped'));
        }
      }
    });
    it(`all writes preserve the fixture, unknown lines, BOM=${!!bom}, EOL=${JSON.stringify(eol)}, final=${final}`, () => {
      const base = fixture.replace(`${bike}\n`, `${bike}\n${odd}\n`);
      const text = encode(base);
      const l = loc(text);
      const added = '- [ ] **New project:** Next: first step ⏳ 2026-10-04 [[New]]';
      expect(ok(kernel.captureActiveWork(text, { name: 'New project', next: 'first step', review: '2026-10-04', link: '[[New]]' })).text)
        .toBe(encode(base.replace(`${bike}\n`, `${bike}\n${added}\n`)));
      const edited = bike.replace('Bike repair', 'Bicycle repair').replace('call the shop', 'book repair').replace('2026-09-20', '2026-10-01');
      expect(ok(kernel.editActiveWork(text, l, { name: 'Bicycle repair', next: 'book repair', review: '2026-10-01' })).text)
        .toBe(encode(base.replace(bike, edited)));
      for (const action of ['keep', 'done', 'park', 'drop'] as const) {
        const after = action === 'keep' ? bike.replace('2026-09-20', '2026-10-04') : action === 'park' ? bike :
          action === 'done' ? `${bike.replace('[ ]', '[x]')} ✅ ${today}` : `${bike} ❌ ${today} no longer needed`;
        const expected = action === 'keep' ? base.replace(bike, after) : base.replace(`${bike}\n`, '').replace(
          action === 'park' ? parked : dropped, `${action === 'park' ? parked : dropped}\n${after}`);
        const r = ok(kernel.reviewActiveWork(text, l, action, today, 'no longer needed'));
        expect(r.text).toBe(encode(expected));
        expect(ok(kernel.undoActiveWork(r.text, r.text, text, r.effect)).text).toBe(text);
        expect(kernel.undoActiveWork(r.text + eol, r.text, text, r.effect)).toMatchObject({ code: 'refused:undo-expired' });
      }
    });
  }

  it('parses the real structure, optional fields and verbatim unknown lines', () => {
    const p = kernel.parseActiveWork(fixture.replace(`${bike}\n`, `${bike}\n${odd}\n`), today);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ name: 'Garden plan', outcome: 'beds ready for spring.', next: 'order seed catalogue', review: '2026-10-03', link: '[[Garden Plan]]', needsReview: false });
    expect(p.items[1]).toMatchObject({ needsReview: true, lineText: bike });
    expect(p.unknownNowLines).toEqual(['', odd, '', 'Prose paragraph that follows the items inside Now.', '']);
    for (const tail of ['', ' outcome', ' Next: step', ' ⏳ 2026-09-27', ' [[Note]]']) {
      const parsed = kernel.parseActiveWork(`## Now\n- [ ] **Minimal:**${tail}`, today);
      expect(parsed.ok && parsed.items[0]).toMatchObject({ name: 'Minimal', needsReview: false });
    }
  });

  it('removes only field spans and inserts absent fields in grammar order', () => {
    expect(ok(kernel.editActiveWork(fixture, loc(), { next: null, review: null })).text)
      .toBe(fixture.replace(bike, '- [ ] **Bike repair:** commuting again. [[Bike]]'));
    const minimal = '- [ ] **Bike repair:** [[Bike]]  ';
    const input = fixture.replace(bike, minimal);
    expect(ok(kernel.editActiveWork(input, loc(input, minimal), { next: 'call', review: '2026-10-04' })).text)
      .toBe(fixture.replace(bike, '- [ ] **Bike repair:** Next: call ⏳ 2026-10-04 [[Bike]]  '));
  });

  it.each(['<!--', '%%'])('refuses hidden-block opener %s in capture, edit and drop', (opener) => {
    for (const field of ['name', 'next'] as const) {
      expect(kernel.captureActiveWork(fixture, { name: 'New', [field]: `stopped ${opener} later` }))
        .toMatchObject({ ok: false, code: 'refused:invalid-edit' });
      expect(kernel.editActiveWork(fixture, loc(), { [field]: `stopped ${opener} later` }))
        .toMatchObject({ ok: false, code: 'refused:invalid-edit' });
    }
    expect(kernel.captureActiveWork(fixture, { name: 'New', link: `[[${opener}]]` }))
      .toMatchObject({ ok: false, code: 'refused:invalid-edit' });
    expect(kernel.reviewActiveWork(fixture, loc(), 'drop', today, `stopped ${opener} later`))
      .toMatchObject({ ok: false, code: 'refused:invalid-edit' });
    const line = `- [ ] **\`Name:** [[${opener}\`]]`;
    const text = `## Now\n${line}\n\n## Rules\nKeep this visible\n`;
    expect(kernel.editActiveWork(text, loc(text, line), { name: 'Name' }))
      .toMatchObject({ ok: false, code: 'refused:invalid-edit' });
  });

  it.each(['park', 'done', 'drop'] as const)('creates a missing section before Rules: %s', (action) => {
    const name = action === 'park' ? 'Parked' : 'Dropped or done';
    const start = fixture.indexOf(`## ${name}`);
    const end = fixture.indexOf('\n## ', start + 3) + 1;
    const base = fixture.slice(0, start) + fixture.slice(end);
    const moved = action === 'park' ? bike : action === 'done' ? `${bike.replace('[ ]', '[x]')} ✅ ${today}` : `${bike} ❌ ${today} stopped`;
    const r = ok(kernel.reviewActiveWork(base, loc(base), action, today, 'stopped'));
    expect(r.text).toBe(base.replace(`${bike}\n`, '').replace('## Rules', `## ${name}\n\n${moved}\n\n## Rules`));
  });

  it('creates a missing section at EOF and handles target sections before Now', () => {
    const text = `## Parked\n\n${parked}\n\n## Now\n\n${bike}`;
    expect(ok(kernel.reviewActiveWork(text, loc(text), 'park', today)).text).toBe(`## Parked\n\n${parked}\n${bike}\n\n## Now\n`);
    const simple = `## Now\n\n${bike}\n`;
    expect(ok(kernel.reviewActiveWork(simple, loc(simple), 'done', today)).text)
      .toBe(`## Now\n\n\n## Dropped or done\n\n${bike.replace('[ ]', '[x]')} ✅ ${today}\n\n`);
    expect(ok(kernel.reviewActiveWork(simple.trimEnd(), loc(simple.trimEnd()), 'park', today)).text)
      .toBe(`## Now\n\n\n## Parked\n\n${bike}`);
  });

  it('uses the heading blank rule when Now has no items; trailing prose stays in place', () => {
    for (const blank of ['', '\n']) {
      const text = `## Now\n${blank}Prose\n`;
      expect(ok(kernel.captureActiveWork(text, { name: 'New' })).text).toBe('## Now\n\n- [ ] **New:**\nProse\n');
    }
  });

  it('hidden item-shaped lines stay read-only and unchanged', () => {
    const hidden = `\n\`\`\`\n${garden}\n\`\`\`\n<!--\n${garden}\n-->\n`;
    const base = fixture.replace('## Now\n', `## Now\n${hidden}`);
    const parsed = kernel.parseActiveWork(base, today);
    expect(parsed.ok && parsed.items).toHaveLength(2);
    expect(ok(kernel.reviewActiveWork(base, loc(base), 'keep', today)).text).toBe(base.replace(bike, bike.replace('2026-09-20', '2026-10-04')));
    expect(kernel.editActiveWork(base, loc(base, odd), { name: 'Changed' })).toMatchObject({ code: 'conflict:task-changed' });
  });
});

// Execute changed copies of the production module; no source files or test expectations are changed.
const source = readFileSync(new URL('./active-work.ts', import.meta.url), 'utf8');
function mutant(from: string, to: string): typeof kernel {
  expect(source).toContain(from);
  const js = ts.transpileModule(source.replace(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const modules: Record<string, unknown> = { './scan.ts': scan, './text.ts': textTools };
  runInNewContext(js, { exports, require: (path: string) => { if (!(path in modules)) throw new Error(path); return modules[path]; } });
  return exports as typeof kernel;
}
const cases: { name: string; from: string; to: string; run: (k: typeof kernel) => unknown; expected: Record<string, unknown> }[] = [
  { name: 'capture child insertion', from: 'hasChildren(lines, last)', to: 'false', run: (k) => k.captureActiveWork(fixture.replace(bike, `${bike}\n  child`), { name: 'New' }), expected: { code: 'refused:structure' } },
  { name: 'move source children', from: 'hasChildren(a.doc.lines, t.lineIndex)', to: 'false', run: (k) => k.reviewActiveWork(fixture.replace(bike, `${bike}\n  child`), loc(), 'park', today), expected: { code: 'refused:structure' } },
  { name: 'move destination children', from: 'hasChildren(lines, last)', to: 'false', run: (k) => k.reviewActiveWork(fixture.replace(parked, `${parked}\n  child`), loc(), 'park', today), expected: { code: 'refused:structure' } },
  { name: 'nested bullet is not an insertion anchor', from: '!/^[ \\t]/.test(lines[i]!) && ', to: '', run: (k) => k.reviewActiveWork(fixture.replace(parked, `${parked}\n  - child`), loc(), 'park', today), expected: { code: 'refused:structure' } },
  { name: 'drop hidden Markdown', from: "return refuse('refused:invalid-edit', 'The reviewed item cannot open hidden Markdown.');", to: '{}', run: (k) => k.reviewActiveWork(fixture, loc(), 'drop', today, 'stopped <!-- later'), expected: { code: 'refused:invalid-edit' } },
  { name: 'edit exposes hidden Markdown', from: 'if (!visible.visible[0] || !visible.cleanAfter[0]) return invalid();', to: '', run: (k) => {
    const line = '- [ ] **`Name:** [[<!--`]]';
    const text = `## Now\n${line}\n`;
    return k.editActiveWork(text, loc(text, line), { name: 'Name' });
  }, expected: { code: 'refused:invalid-edit' } },
  { name: 'twins at read', from: 'loc.occurrencesAtRead !== 1', to: 'false', run: (k) => k.editActiveWork(fixture, { ...loc(), sameRevision: false, occurrencesAtRead: 2 }, { name: 'New' }), expected: { code: 'conflict:ambiguous' } },
  { name: 'twins now', from: 'matches.length > 1', to: 'false', run: (k) => k.editActiveWork(fixture.replace(bike, `${bike}\n${bike}`), { ...loc(), sameRevision: false }, { name: 'New' }), expected: { code: 'conflict:ambiguous' } },
  { name: 'changed line', from: 't.lineText === loc.lineText &&', to: '', run: (k) => k.editActiveWork(fixture.replace('call the shop', 'call another shop'), loc(), { name: 'New' }), expected: { code: 'conflict:task-changed' } },
  { name: 'moved to Parked', from: "matches[0]!.section !== 'Now'", to: 'false', run: (k) => k.editActiveWork(`## Now\n\n## Parked\n${bike}\n`, { ...loc(), sameRevision: false }, { name: 'New' }), expected: { code: 'conflict:task-changed' } },
  { name: 'round-trip injection', from: 'return invalid();\n  const visible', to: '{}\n  const visible', run: (k) => k.editActiveWork(fixture, loc(), { next: 'step ⏳ 2026-10-03' }), expected: { code: 'refused:invalid-edit' } },
  { name: 'no-op', from: ' || line === t.lineText', to: '', run: (k) => k.editActiveWork(fixture, loc(), {}), expected: { code: 'refused:invalid-edit' } },
  { name: 'invalid date', from: 'new Date(s).toISOString().slice(0, 10) === s', to: 'true', run: (k) => k.editActiveWork(fixture, loc(), { review: '2026-02-30' }), expected: { code: 'refused:invalid-edit' } },
  { name: 'conflict markers', from: "writeBlock = refuse('refused:vault-conflict', 'File contains Git conflict markers.');", to: 'writeBlock = null;', run: (k) => k.reviewActiveWork(fixture + '<<<<<<< HEAD\n', loc(), 'done', today), expected: { code: 'refused:vault-conflict' } },
  { name: 'duplicate sections', from: "writeBlock = refuse('refused:structure', 'Active Work sections are missing or ambiguous.');", to: 'writeBlock = null;', run: (k) => k.captureActiveWork(fixture + '## Now\n', { name: 'New' }), expected: { code: 'refused:structure' } },
  { name: 'capture injection', from: "return refuse('refused:invalid-edit', 'The new item must round-trip without introducing other fields.');", to: '{}', run: (k) => k.captureActiveWork(fixture, { name: 'New', next: 'step ⏳ 2026-10-03' }), expected: { code: 'refused:invalid-edit' } },
  { name: 'capture hidden Markdown', from: "return refuse('refused:invalid-edit', 'The item cannot open a Markdown comment.');", to: '{}', run: (k) => k.captureActiveWork(fixture, { name: 'New', link: '[[<!--]]' }), expected: { code: 'refused:invalid-edit' } },
  { name: 'missing section inside unclosed fence', from: "return refuse('refused:structure', 'Cannot create a section inside hidden Markdown.');", to: '{}', run: (k) => k.reviewActiveWork(`## Now\n${bike}\n\`\`\``, loc(`## Now\n${bike}\n\`\`\``), 'park', today), expected: { code: 'refused:structure' } },
  { name: 'drop reason', from: "return refuse('invalid', 'Invalid review date, action or reason.');", to: '{}', run: (k) => k.reviewActiveWork(fixture, loc(), 'drop', today, '\n'), expected: { code: 'invalid' } },
  { name: 'exact-only Undo', from: 'text !== targetText', to: 'false', run: (k) => k.undoActiveWork('changed', 'target', 'parent', { kind: 'active-work', op: 'done', beforeLineText: bike, afterLineText: bike }), expected: { code: 'refused:undo-expired' } },
];
it.each(cases)('guard mutation: $name', ({ from, to, run, expected }) => {
  expect(run(kernel)).toMatchObject(expected);
  // The production refusal assertion must fail against the changed implementation.
  const broken = mutant(from, to);
  expect(() => expect(run(broken)).toMatchObject(expected)).toThrow();
});

describe('ADR-0021 done items', () => {
  it('reads review-done lines back; drops, prose, hidden and malformed lines are not completions', () => {
    const done = ok(kernel.reviewActiveWork(fixture, loc(), 'done', today)).text;
    const dropped2 = ok(kernel.reviewActiveWork(done, loc(done, garden), 'drop', today, 'stopped')).text;
    const text = dropped2.replace(dropped, `${dropped}\n<!--\n- [x] **Hidden:** x ✅ 2026-09-01\n-->\n- [x] **Bad date:** x ✅ 2026-02-30\n- [x] no grammar ✅ 2026-09-02`);
    const parsed = kernel.parseActiveWork(text, today);
    if (!parsed.ok) throw new Error('parse');
    expect(parsed.doneItems).toEqual([expect.objectContaining({
      name: 'Bike repair', outcome: 'commuting again.', link: '[[Bike]]', done: today, occurrences: 1,
      lineText: `${bike.replace('[ ]', '[x]')} ✅ ${today}`,
    })]);
    expect(parsed.items.some((t) => t.section === 'Dropped or done')).toBe(false);
  });
});
