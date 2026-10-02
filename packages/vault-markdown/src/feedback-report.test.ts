// Ready Backlog feedback write: exact golden bytes. Synthetic notes only.
import { describe, expect, it } from 'vitest';
import { applyFeedbackReport, revertFeedbackReport } from './feedback-report.ts';
import type { FeedbackReportInput } from './feedback-report.ts';

const BOM = '\uFEFF';
const bug: FeedbackReportInput = { kind: 'bug', text: 'Sync *breaks* [on] `fast` phones when | offline', screen: 'iOS Home', appVersion: '1.2.3', date: '2026-10-01' };
const wish: FeedbackReportInput = { kind: 'wish', text: 'Let me *pin* [a] `note` and | keep it visible', screen: 'Android', appVersion: '2.0-beta.1', date: '2026-10-02' };

function applied(text: string, input: FeedbackReportInput): string {
  const result = applyFeedbackReport(text, input);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.text;
}

function refusal(text: string, input: FeedbackReportInput): string {
  const result = applyFeedbackReport(text, input);
  return result.ok ? 'ok' : result.code;
}

it('inserts a bug row after the first Bug backlog separator row', () => {
  const source = ['# Ready', '', '## Bug backlog', '', '| Bug | Seen | Expected | Likely cause (hint) |', '| --- | --- | --- | --- |', '| **B2 - Old bug** | | | |', ''].join('\n');
  const expected = ['# Ready', '', '## Bug backlog', '', '| Bug | Seen | Expected | Likely cause (hint) |', '| --- | --- | --- | --- |', '| **B3 - Sync breaks on fast phones when** | 2026-10-01 iOS Home (app 1.2.3): Sync *breaks* [on] `fast` phones when \\| offline | | |', '| **B2 - Old bug** | | | |', ''].join('\n');
  expect(applied(source, bug)).toBe(expected);
});

it('keeps CRLF, BOM and untouched bytes, and uses max B-number + 1 across gaps', () => {
  const source = [BOM + '# Ready', '', '## Bug backlog', '', '| Bug | Seen | Expected | Likely cause (hint) |', '| --- | --- | --- | --- |', '| **B7 - Old** | x | y | z |'].join('\r\n') + '\r\n';
  const expected = [BOM + '# Ready', '', '## Bug backlog', '', '| Bug | Seen | Expected | Likely cause (hint) |', '| --- | --- | --- | --- |', '| **B8 - Sync breaks on fast phones when** | 2026-10-01 iOS Home (app 1.2.3): Sync *breaks* [on] `fast` phones when \\| offline | | |', '| **B7 - Old** | x | y | z |'].join('\r\n') + '\r\n';
  expect(applied(source, bug)).toBe(expected);
});

it('inserts a wish line after the last Candidates bullet', () => {
  const source = ['# Ready', '', '## Candidates to refine next', '', '- First', '- Second', ''].join('\n');
  const expected = ['# Ready', '', '## Candidates to refine next', '', '- First', '- Second', '- **Let me pin a note and**: 2026-10-02 Android (app 2.0-beta.1): Let me *pin* [a] `note` and \\| keep it visible', ''].join('\n');
  expect(applied(source, wish)).toBe(expected);
});

it('collapses whitespace runs and escapes pipes', () => {
  const source = '## Candidates to refine next\n\n- Existing\n';
  const result = applyFeedbackReport(source, { ...wish, text: 'A\n  B\t | C |  D' });
  expect(result.ok && result.text).toContain('- **A B \\| C \\| D**: 2026-10-02 Android (app 2.0-beta.1): A B \\| C \\| D');
});

it('missing or duplicate structure is a typed refusal and leaves the text unchanged', () => {
  expect(refusal('## Bug backlog\n\n## Bug backlog\n', bug)).toBe('refused:structure');
  expect(refusal('## Bug backlog\n\n| Bug | Seen | Expected | Likely cause (hint) |\n', bug)).toBe('refused:structure');
  expect(refusal('## Candidates to refine next\n\nNo list\n', wish)).toBe('refused:structure');
});

it('revert removes exactly the written line; absent or duplicated line is a conflict refusal', () => {
  const source = '## Bug backlog\n\n| Bug | Seen | Expected | Likely cause (hint) |\n| --- | --- | --- | --- |\n';
  const after = applyFeedbackReport(source, bug);
  if (!after.ok) throw new Error(`refused: ${after.code}`);
  expect(revertFeedbackReport(after.text, after.effect.lineText)).toMatchObject({ ok: true, text: source });
  expect(revertFeedbackReport(source, after.effect.lineText)).toMatchObject({ ok: false, code: 'conflict:report-changed' });
  expect(revertFeedbackReport(`${after.text}${after.effect.lineText}\n`, after.effect.lineText)).toMatchObject({ ok: false, code: 'conflict:report-changed' });
});
