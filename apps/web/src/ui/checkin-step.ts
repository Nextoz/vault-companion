// Redesign R3b (review #7): the inline Today check-in as a pure step machine. One row of five round targets asks for
// mood, then turns into "Energy?", then "Sleep?". MoodCheckin (ADR-0036) requires mood, energy and sleep together, so
// the row submits once, after the sleep pick, and offers no Skip: a skipped field would have to be invented. No React.
import { chipLabel } from './MoodCard.tsx';

/** Five mood and energy targets on the existing −3…+3 scale; the ends (±3) stay on the full Check-in sheet. */
export const CHECKIN_SCALE = [-2, -1, 0, 1, 2] as const;
/** Five sleep targets in whole hours; anything else goes through "Other", the full sheet. */
export const SLEEP_HOURS = [5, 6, 7, 8, 9] as const;

export type CheckinStep =
  | { readonly step: 'mood' }
  | { readonly step: 'energy'; readonly mood: number }
  | { readonly step: 'sleep'; readonly mood: number; readonly energy: number }
  | { readonly step: 'ready'; readonly mood: number; readonly energy: number; readonly sleep: number };

export type CheckinEvent = { readonly kind: 'pick'; readonly value: number } | { readonly kind: 'back' };

export const CHECKIN_START: CheckinStep = { step: 'mood' };

/** The values the current step offers; `ready` offers none. */
export function checkinOptions(state: CheckinStep): readonly number[] {
  if (state.step === 'mood' || state.step === 'energy') return CHECKIN_SCALE;
  if (state.step === 'sleep') return SLEEP_HOURS;
  return [];
}

/**
 * One tap moves one step: mood -> energy -> sleep -> ready (submit). A value the step does not offer is ignored, and
 * Back undoes the last answer. Pure and total.
 */
export function checkinNext(state: CheckinStep, event: CheckinEvent): CheckinStep {
  if (event.kind === 'back') {
    if (state.step === 'energy') return CHECKIN_START;
    if (state.step === 'sleep') return { step: 'energy', mood: state.mood };
    return state;
  }
  if (!checkinOptions(state).includes(event.value)) return state;
  switch (state.step) {
    case 'mood': return { step: 'energy', mood: event.value };
    case 'energy': return { step: 'sleep', mood: state.mood, energy: event.value };
    case 'sleep': return { step: 'ready', mood: state.mood, energy: state.energy, sleep: event.value };
    case 'ready': return state;
  }
}

export interface CheckinCopy {
  /** The visible question. */
  readonly prompt: string;
  /** The group's accessible name, and the prefix of each target's name ("Mood +2", "Sleep 7 h"). */
  readonly kind: 'Mood' | 'Energy' | 'Sleep';
  /** The hints under the two ends of the row. */
  readonly ends: readonly [string, string];
  /** The answers so far, shown as the Back control ("Mood +2 · Energy −1"); null on the first step. */
  readonly answered: string | null;
}

export function checkinCopy(state: CheckinStep): CheckinCopy {
  switch (state.step) {
    case 'mood':
    case 'ready':
      return { prompt: 'How are you today?', kind: 'Mood', ends: ['low', 'great'], answered: null };
    case 'energy':
      return { prompt: 'Energy?', kind: 'Energy', ends: ['drained', 'energised'], answered: chipLabel('Mood', state.mood) };
    case 'sleep':
      return { prompt: 'Sleep?', kind: 'Sleep', ends: ['hours', ''], answered: `${chipLabel('Mood', state.mood)} · ${chipLabel('Energy', state.energy)}` };
  }
}

/** The target's visible text: the signed scale value ("+2", "−1", "0") or the hours ("7"). */
export function targetText(kind: CheckinCopy['kind'], value: number): string {
  return kind === 'Sleep' ? String(value) : chipLabel(kind, value).slice(kind.length + 1);
}

/** The target's accessible name: "Mood +2", "Energy −1", "Sleep 7 hours". */
export function targetName(kind: CheckinCopy['kind'], value: number): string {
  return kind === 'Sleep' ? `Sleep ${value} hours` : chipLabel(kind, value);
}
