import { describe, expect, it } from 'vitest';
import { explanationInfo, morningSummary } from './Morning.tsx';

const ok = (markdown: string, path = 'Research/Explained/2026-09-30 - x.md') =>
  ({ status: 'ok' as const, revision: 'a'.repeat(40), path, blobSha: 'b'.repeat(40), markdown });
const note = (status: string, title: string) => `---\ntype: research-explained\nstatus: ${status}\n---\n\n# ${title}\n\nBody\n`;

describe('This morning panel', () => {
  it('reads title and state from the note, ignoring a status line in the body', () => {
    expect(explanationInfo(note('complete', 'Attention for Beginners'))).toEqual({ title: 'Attention for Beginners', status: 'complete' });
    expect(explanationInfo(note('pending', 'X') + 'status: complete\n')).toMatchObject({ status: 'pending' });
    expect(explanationInfo('# No frontmatter\n')).toEqual({ title: 'No frontmatter', status: 'unknown' });
  });
  it('summarises the brief and the explanation states in one line', () => {
    const data = { revision: 'a'.repeat(40), date: '2026-09-30', brief: ok('# Brief\n', 'Research/Reading Briefs/b.md'),
      explained: [ok(note('complete', 'A')), ok(note('complete', 'B')), ok(note('pending', 'C'))] };
    expect(morningSummary(data)).toBe('Reading brief · 2 explained · 1 pending');
    expect(morningSummary({ ...data, brief: null, explained: [] })).toBe('No reading brief yet');
  });
});
