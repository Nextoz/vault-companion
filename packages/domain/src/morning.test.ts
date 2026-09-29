import { describe, expect, it } from 'vitest';
import { createMorningService } from './morning.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const note = (status: string, title: string) => `---\ntype: research-explained\nstatus: ${status}\n---\n\n# ${title}\n`;

describe('readMorning (ADR-0029 Part 2)', () => {
  it("returns the day's brief and the explanations of the carry-over window, newest first", async () => {
    const store = await InMemoryStore.create({
      'Research/Reading Briefs/Research Reading Brief - 2026-09-30.md': '# Brief\n\n## Read today\n',
      'Research/Reading Briefs/Research Reading Brief - 2026-09-29.md': '# Old brief\n',
      'Research/Explained/2026-09-30 - b.md': note('complete', 'B'),
      'Research/Explained/2026-09-30 - a.md': note('pending', 'A'),
      'Research/Explained/2026-09-28 - c.md': note('pending', 'C'),
      'Research/Explained/2026-09-27 - too-old.md': note('complete', 'Old'),
      'Research/Explained/sub/2026-09-30 - nested.md': note('complete', 'Nested'),
    });
    const service = createMorningService({ store, now: () => new Date('2026-09-30T05:00:00Z'), timeZone: 'Europe/Copenhagen' });
    const r = await service.readMorning();
    if ('code' in r) throw new Error('unexpected error');
    expect(r.date).toBe('2026-09-30');
    expect(r.brief).toMatchObject({ status: 'ok', path: 'Research/Reading Briefs/Research Reading Brief - 2026-09-30.md' });
    expect(r.explained.map((n) => (n.status === 'ok' ? n.path : n.code))).toEqual([
      'Research/Explained/2026-09-30 - b.md', 'Research/Explained/2026-09-30 - a.md', 'Research/Explained/2026-09-28 - c.md',
    ]);
  });

  it('no brief today and no Explained folder ⇒ empty, not an error', async () => {
    const store = await InMemoryStore.create({ 'Inbox/x.md': 'x\n' });
    const r = await createMorningService({ store, now: () => new Date('2026-09-30T05:00:00Z'), timeZone: 'Europe/Copenhagen' }).readMorning();
    expect(r).toMatchObject({ brief: null, explained: [] });
  });
});
