import type { JevAnswer } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { jevBars, validateAskJevDrafts, type AskJevDraft } from './ask-jev.ts';

const yesNo = (question: string): AskJevDraft => ({ kind: 'yes-no', question });

describe('validateAskJevDrafts', () => {
  it('parses valid yes/no, choose and rate rows into typed questions', () => {
    const result = validateAskJevDrafts([
      yesNo(' Is this clear? '),
      { kind: 'choose', question: 'Which one?', optionsText: 'A, B, C' },
      { kind: 'rate', question: 'How ready?', levelsText: 'Low, High' },
    ]);
    expect(result).toEqual({
      ok: true,
      questions: [
        { kind: 'yes-no', question: 'Is this clear?' },
        { kind: 'choose', question: 'Which one?', options: ['A', 'B', 'C'] },
        { kind: 'rate', question: 'How ready?', levels: ['Low', 'High'] },
      ],
    });
  });

  it('rejects an empty question', () => {
    expect(validateAskJevDrafts([yesNo('  ')])).toEqual({ ok: false, message: 'Question 1 needs some text.' });
  });

  it('rejects more than three rows', () => {
    const drafts = Array.from({ length: 4 }, () => yesNo('x'));
    expect(validateAskJevDrafts(drafts)).toEqual({ ok: false, message: 'Ask Jev at most 3 questions at a time.' });
  });

  it('rejects choose rows with fewer than two options', () => {
    const drafts: AskJevDraft[] = [{ kind: 'choose', question: 'Which?', optionsText: 'A' }];
    expect(validateAskJevDrafts(drafts)).toEqual({ ok: false, message: 'Question 1: list 2–8 options, separated by commas.' });
  });

  it('rejects duplicate scale labels', () => {
    const drafts: AskJevDraft[] = [{ kind: 'rate', question: 'Ready?', levelsText: 'Low, Low' }];
    expect(validateAskJevDrafts(drafts)).toEqual({ ok: false, message: 'Question 1: list 2–8 scale labels, separated by commas.' });
  });
});

describe('jevBars', () => {
  it('splits yes/no probability into Yes and No percentages', () => {
    const answer: JevAnswer = { kind: 'yes-no', question: 'Clear?', probability: 0.7 };
    expect(jevBars(answer)).toEqual([
      { label: 'Yes', percent: 70, current: true },
      { label: 'No', percent: 30, current: false },
    ]);
  });

  it('marks the chosen option and keeps choice probabilities', () => {
    const answer: JevAnswer = { kind: 'choose', question: 'Which?', choice: 'B', probabilities: { A: 0.25, B: 0.75 } };
    expect(jevBars(answer)).toEqual([
      { label: 'A', percent: 25, current: false },
      { label: 'B', percent: 75, current: true },
    ]);
  });

  it('renders rate labels as bars', () => {
    const answer: JevAnswer = { kind: 'rate', question: 'Ready?', score: 'High', probabilities: { Low: 0.2, High: 0.8 } };
    expect(jevBars(answer)).toEqual([
      { label: 'Low', percent: 20, current: false },
      { label: 'High', percent: 80, current: true },
    ]);
  });
});
