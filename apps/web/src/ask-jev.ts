// Ask Jev (ADR-0057): pure device-side helpers for the question form and the probability bars, kept out of the
// component so validation and rendering can be tested without a DOM.
import type { AskJevQuestion, JevAnswer } from '@vault-companion/contracts';

export const MAX_ASK_JEV_QUESTIONS = 3;

export type AskJevDraft =
  | { kind: 'yes-no'; question: string }
  | { kind: 'choose'; question: string; optionsText: string }
  | { kind: 'rate'; question: string; levelsText: string };

export interface JevBar {
  readonly label: string;
  readonly percent: number;
  readonly current: boolean;
}

export function emptyAskJevDraft(): AskJevDraft {
  return { kind: 'yes-no', question: '' };
}

function parseLabels(text: string): string[] | null {
  const labels = text.split(',').map((label) => label.trim()).filter(Boolean);
  if (labels.some((label) => label.length > 120)) return null;
  if (labels.length < 2 || labels.length > 8) return null;
  if (new Set(labels).size !== labels.length) return null;
  return labels;
}

export type AskJevValidation =
  | { ok: true; questions: AskJevQuestion[] }
  | { ok: false; message: string };

export function validateAskJevDrafts(drafts: readonly AskJevDraft[]): AskJevValidation {
  if (drafts.length === 0) return { ok: false, message: 'Add at least one question.' };
  if (drafts.length > MAX_ASK_JEV_QUESTIONS) return { ok: false, message: 'Ask Jev at most 3 questions at a time.' };
  const questions: AskJevQuestion[] = [];
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]!;
    const question = draft.question.trim();
    if (!question) return { ok: false, message: `Question ${index + 1} needs some text.` };
    if (question.length > 400) return { ok: false, message: `Question ${index + 1} is too long.` };
    if (draft.kind === 'yes-no') {
      questions.push({ kind: 'yes-no', question });
      continue;
    }
    const raw = draft.kind === 'choose' ? draft.optionsText : draft.levelsText;
    const labels = parseLabels(raw);
    if (!labels) {
      return { ok: false, message: `Question ${index + 1}: list 2–8 ${draft.kind === 'choose' ? 'options' : 'scale labels'}, separated by commas.` };
    }
    questions.push(draft.kind === 'choose'
      ? { kind: 'choose', question, options: labels }
      : { kind: 'rate', question, levels: labels });
  }
  return { ok: true, questions };
}

export function jevBars(answer: JevAnswer): JevBar[] {
  const percent = (value: number) => Math.round(value * 100);
  switch (answer.kind) {
    case 'yes-no':
      return [
        { label: 'Yes', percent: percent(answer.probability), current: answer.probability >= 0.5 },
        { label: 'No', percent: percent(1 - answer.probability), current: answer.probability < 0.5 },
      ];
    case 'choose':
      return Object.entries(answer.probabilities).map(([label, probability]) => ({
        label,
        percent: percent(probability),
        current: label === answer.choice,
      }));
    case 'rate':
      return Object.entries(answer.probabilities).map(([label, probability]) => ({
        label,
        percent: percent(probability),
        current: label === answer.score,
      }));
  }
}
