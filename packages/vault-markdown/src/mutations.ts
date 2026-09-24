import type { CaptureTaskInput, CompleteEffect, LocatorInput, MutationOk, Refusal, UndoInput } from './api.ts';

/** docs/vault-contract.md §3 + §4.1. `doneDate` is YYYY-MM-DD. */
export function completeTask(_text: string, _locator: LocatorInput, _doneDate: string): MutationOk<CompleteEffect> | Refusal {
  throw new Error('not implemented');
}

/** docs/vault-contract.md §4.2 (exact inverse when unchanged, semantic inverse otherwise). */
export function undoCompleteTask(_text: string, _input: UndoInput): MutationOk<{ openLineText: string }> | Refusal {
  throw new Error('not implemented');
}

/** docs/vault-contract.md §4.3–4.4. */
export function captureTask(_text: string, _input: CaptureTaskInput): MutationOk<{ lineText: string }> | Refusal {
  throw new Error('not implemented');
}
