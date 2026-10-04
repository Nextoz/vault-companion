import type { LearningRow } from '@vault-companion/contracts';
import { parseLearningPasteLine } from '@vault-companion/vault-markdown';
import { describe, expect, it } from 'vitest';
import {
  applyPasteLine,
  draftToSession,
  kindName,
  learningWeekBars,
  newLearningDraft,
  parsePasteLine,
  pasteToDraft,
  scoreTrends,
  scoreValue,
} from '../learning.ts';

const row = (kind: string, date: string, score: string, minutes = ''): LearningRow =>
  ({ date, kind, minutes, score, detail: '', topic: '', note: '' });

describe('scoreValue', () => {
  it('reads a 3/5 score as the right/asked ratio, never as 3', () => {
    expect(scoreValue('3/5')).toBe(0.6);
    expect(scoreValue('3/5')).not.toBe(3);
    expect(scoreValue('4 / 5')).toBe(0.8);
  });
  it('reads a plain number and refuses the rest', () => {
    expect(scoreValue('7')).toBe(7);
    expect(scoreValue('4.5')).toBe(4.5);
    for (const bad of ['', '  ', 'three', '4,5', '0/0', '1/2/3']) expect(scoreValue(bad)).toBeNull();
  });
});

describe('scoreTrends', () => {
  it('keeps only kinds with at least two numeric scores, oldest first', () => {
    const rows = [row('a', '2026-10-04', '4/5'), row('b', '2026-10-03', '9'), row('a', '2026-10-02', '3/5'), row('a', '2026-10-01', '')];
    expect(scoreTrends(rows)).toEqual([{ kind: 'a', values: [0.6, 0.8] }]);
  });
  it('does not throw for a kind id the Kinds table does not list', () => {
    const rows = [row('unknown-kind', '2026-10-04', '2'), row('unknown-kind', '2026-10-03', '4')];
    expect(scoreTrends(rows)).toEqual([{ kind: 'unknown-kind', values: [4, 2] }]);
  });
});

describe('learningWeekBars (Mon start, Copenhagen day supplied by the caller)', () => {
  it('puts a Sunday in the week that starts the previous Monday, and Monday in the current week', () => {
    // 2026-10-04 is a Sunday; its week starts Mon 2026-09-28.
    const bars = learningWeekBars(['2026-09-27', '2026-09-28', '2026-10-04'], '2026-10-04');
    expect(bars).toHaveLength(8);
    expect(bars.at(-1)).toMatchObject({ value: 2, current: true });
    expect(bars.at(-2)).toMatchObject({ value: 1, current: false });
  });
  it('ignores malformed dates', () => {
    expect(learningWeekBars(['not-a-date'], '2026-10-04').reduce((n, b) => n + b.value, 0)).toBe(0);
  });
});

describe('paste -> draft', () => {
  const paste = { kind: 'dictation', date: '2026-10-03', minutes: 12, score: '3/5', detail: 'acc 8', topic: 'weather report' };
  it('maps every field and clears the note', () => {
    expect(pasteToDraft(paste)).toEqual({
      kind: 'dictation', date: '2026-10-03', minutes: '12', score: '3/5', detail: 'acc 8', topic: 'weather report', note: '',
    });
  });
  it('fills the sheet from a pasted line and changes nothing on a refusal', () => {
    const draft = newLearningDraft('2026-10-04');
    const filled = applyPasteLine(draft, 'LG | dictation | 2026-10-03 | min 12 | score 3/5 | acc 8 | topic: weather report');
    expect(filled.error).toBeNull();
    expect(filled.draft).toMatchObject({ kind: 'dictation', date: '2026-10-03', minutes: '12', score: '3/5', detail: 'acc 8', topic: 'weather report' });
    const refused = applyPasteLine(filled.draft, 'nonsense');
    expect(refused.error).toMatch(/does not match/i);
    expect(refused.draft).toBe(filled.draft);
  });
});

describe('parsePasteLine mirrors the vault-markdown kernel (cross-checked)', () => {
  it('accepts and refuses exactly what ADR-0053 does', () => {
    for (const line of [
      'LG | dictation | 2026-10-04 | min 15 | score 7 | acc 8 | spell 7 | verbs 6 | topic: weather report',
      'LG | dictation | 2026-10-04 | min 0 | score 3/5 | topic: x',
      'LG | d | 2026-10-04 | min 5 | score 1 | topic: a \\| b',
      '',
      'nonsense',
      'LG | dictation | 2026-10-04 | min 15 | score 7 | acc 8 | spell | topic: weather report',
      'LG | dictation | 2026-10-04 | min x | score 7 | topic: weather report',
      'LG | dictation | 2026-02-30 | min 15 | score 7 | topic: weather report',
      'LG | dictation | 2026-10-04 | min 15 | score 123456789 | topic: weather report',
      'LG |  | 2026-10-04 | min 15 | score 7 | topic: weather report',
      'LG | dictation | 2026-10-04 | min 15 | score 7 | topic: ',
    ]) {
      const mine = parsePasteLine(line);
      const kernel = parseLearningPasteLine(line);
      if ('ok' in kernel) expect(mine).toEqual({ ok: false, message: kernel.message });
      else expect(mine).toEqual({ ok: true, paste: kernel });
    }
  });
});

describe('kindName', () => {
  it('uses the table name and falls back to the raw id for an unknown kind', () => {
    expect(kindName([{ id: 'd', name: 'Dictation' }], 'd')).toBe('Dictation');
    expect(kindName([{ id: 'd', name: 'Dictation' }], 'gone')).toBe('gone');
  });
});

describe('draftToSession', () => {
  it('omits an empty minutes field instead of sending 0', () => {
    const session = draftToSession({ ...newLearningDraft('2026-10-04'), kind: 'dictation' });
    expect(session).toEqual({ kind: 'dictation', date: '2026-10-04' });
    expect('minutes' in session).toBe(false);
  });
  it('keeps an explicit 0 and omits blank optional fields', () => {
    const draft = { ...newLearningDraft('2026-10-04'), kind: 'dictation', minutes: '0', score: '  ', detail: '', topic: ' ', note: '' };
    expect(draftToSession(draft)).toEqual({ kind: 'dictation', date: '2026-10-04', minutes: 0 });
  });
  it('sends a numeric score as a number and a ratio score as its string', () => {
    expect(draftToSession({ ...newLearningDraft('2026-10-04'), kind: 'd', score: '7' }).score).toBe(7);
    expect(draftToSession({ ...newLearningDraft('2026-10-04'), kind: 'd', score: '3/5' }).score).toBe('3/5');
  });
});
