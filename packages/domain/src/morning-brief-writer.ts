// Morning Brief writer (MB1b): a model on Scaleway SELECTS from gathered candidates and PHRASES a short brief; this
// module is pure (no I/O, no Worker/React imports). The prompt carries derived labels and flags only — never raw
// metric values, series, or non-candidate text. Parsing validates against the candidate ids/blocks and never throws.

import { z } from 'zod';
import type { HealthMetricKey, WeatherRunWindow } from '@vault-companion/contracts';
import { rankTodos, type BriefTodo, type FreeBlock, type StateLine } from './morning-brief.ts';

/** Training window summary; structurally the gatherer's `TrainingRecent`. Counts and dates only. */
export interface WriterTraining {
  readonly count: number;
  readonly dates: readonly string[];
}

/** One ranked todo candidate: `id` is its index in `WriterInput.todos` (0 = top candidate). */
export interface WriterTodo {
  readonly id: number;
  readonly text: string;
  readonly due: string | null;
  readonly bill: boolean;
}

/** Everything the writer may see. `state` already carries flags only (no metric values). */
export interface WriterInput {
  readonly day: string;
  readonly blocks: readonly FreeBlock[];
  readonly todos: readonly WriterTodo[];
  readonly state: StateLine;
  readonly weatherWindows: readonly WeatherRunWindow[];
  readonly trainingRecent: WriterTraining;
  /** Names of the gatherers that failed; their data is absent, never invented. */
  readonly unavailable: readonly string[];
}

export interface BuildWriterInputArgs {
  readonly day: string;
  readonly blocks: readonly FreeBlock[];
  readonly todos: readonly BriefTodo[];
  readonly state: StateLine;
  readonly weatherWindows: readonly WeatherRunWindow[];
  readonly trainingRecent: WriterTraining;
  readonly unavailable: readonly string[];
}

/** Rank the day's todos (`rankTodos`, top 3) and number them 0..n-1; the model may only reference these ids. */
export function buildWriterInput(args: BuildWriterInputArgs): WriterInput {
  const ranked = rankTodos([...args.todos], args.day);
  return {
    day: args.day,
    blocks: args.blocks,
    state: args.state,
    weatherWindows: args.weatherWindows,
    trainingRecent: args.trainingRecent,
    unavailable: args.unavailable,
    todos: ranked.map((todo, id) => ({ id, text: todo.text, due: todo.due, bill: todo.bill })),
  };
}

// ---- prompt ----

/** Plain-word labels for the derived state flags; the raw metric key never reaches the model as a value. */
const FLAG_LABEL: Record<HealthMetricKey, string> = {
  steps: 'steps',
  headphone_min: 'headphone time',
  first_move: 'first movement',
  last_move: 'last movement',
};

export const WRITER_SYSTEM_PROMPT = [
  'You write a short, plain morning brief for one person.',
  'Rules:',
  '- Choose items only from the candidates below; never invent a commitment or a fact.',
  '- Make an observation, never a diagnosis; never name an episode or a condition.',
  '- If the state is low, choose fewer items and exactly one meaningful action.',
  '- If no state flags are given, make no claim about the state.',
  '- Keep every string at most 240 characters.',
].join('\n');

function blockLine(index: number, block: FreeBlock): string {
  return `${index}. ${block.start} to ${block.end} (${Math.round(block.minutes)} min${block.long ? ', long' : ''})`;
}

function todoLine(todo: WriterTodo): string {
  const due = todo.due ? `due ${todo.due}` : 'no due date';
  return `${todo.id}. "${todo.text}" (${due}${todo.bill ? ', bill' : ''})`;
}

function windowLine(window: WeatherRunWindow): string {
  return `${window.day} ${window.start} to ${window.end} (${window.agreement})`;
}

/** System rules plus a user message of derived labels/flags, block times, and candidate todo text+due. */
export function buildWriterPrompt(input: WriterInput): { system: string; user: string } {
  const stateLines = input.state.flags.map((flag) => `- ${FLAG_LABEL[flag.key]} ${flag.compare} its 30-day median`);
  if (input.state.mood) {
    stateLines.push(`- mood ${input.state.mood.mood}, energy ${input.state.mood.energy}, sleep ${input.state.mood.sleep}`);
  }
  if (input.state.low) stateLines.push('- state is low');

  const user = [
    `Day: ${input.day}`,
    '',
    'Free blocks (index. start to end):',
    ...(input.blocks.length ? input.blocks.map((block, index) => blockLine(index, block)) : ['(none)']),
    '',
    'Todo candidates (id. text (due)):',
    ...(input.todos.length ? input.todos.map(todoLine) : ['(none)']),
    '',
    'State:',
    ...(stateLines.length ? stateLines : ['(no state flags)']),
    '',
    'Weather run window:',
    ...(input.weatherWindows.length ? input.weatherWindows.map(windowLine) : ['(none)']),
    `Recent training: ${input.trainingRecent.count} session(s) in the last 7 days`,
    `Unavailable sources: ${input.unavailable.length ? input.unavailable.join(', ') : 'none'}`,
    '',
    'Reply with JSON only:',
    '{"dayLine": string, "stateLine": string (optional), "gaps": [{"blockIndex": number, "suggestion": string}], "todos": [{"id": number, "firstStep": string}], "encouragement": string}',
    'gaps may only reference a long free block by its index; todos may only use a candidate id and at most 3.',
  ].join('\n');

  return { system: WRITER_SYSTEM_PROMPT, user };
}

// ---- output ----

const capped = z.string().trim().min(1).max(240);

/** The model's JSON contract. Unknown/duplicate ids and non-long gaps are filtered in `parseWriterOutput`. */
export const BriefDraft = z.object({
  dayLine: capped,
  stateLine: capped.optional(),
  gaps: z.array(z.object({ blockIndex: z.number().int().nonnegative(), suggestion: capped })).optional().default([]),
  todos: z.array(z.object({ id: z.number().int().nonnegative(), firstStep: capped })).optional().default([]),
  encouragement: capped,
});
export type BriefDraft = z.infer<typeof BriefDraft>;

/** Strip a ```json ... ``` fence (any language tag) if the whole reply is fenced. */
function unfence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

/**
 * Validate a model reply against the candidate set. Drops todos with an unknown or duplicate id, gaps on a non-long
 * block or duplicate block, and keeps at most 3 todos. Returns null when the reply is unusable; never throws.
 */
export function parseWriterOutput(raw: string, input: WriterInput): BriefDraft | null {
  try {
    const text = unfence(raw);
    if (!text) return null;
    const parsed = BriefDraft.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const draft = parsed.data;

    const candidateIds = new Set(input.todos.map((todo) => todo.id));
    const seenTodos = new Set<number>();
    const todos: BriefDraft['todos'] = [];
    for (const todo of draft.todos) {
      if (todos.length >= 3) break;
      if (!candidateIds.has(todo.id) || seenTodos.has(todo.id)) continue;
      seenTodos.add(todo.id);
      todos.push(todo);
    }

    const longBlocks = new Set(input.blocks.map((block, index) => (block.long ? index : -1)).filter((index) => index >= 0));
    const seenGaps = new Set<number>();
    const gaps: BriefDraft['gaps'] = [];
    for (const gap of draft.gaps) {
      if (!longBlocks.has(gap.blockIndex) || seenGaps.has(gap.blockIndex)) continue;
      seenGaps.add(gap.blockIndex);
      gaps.push(gap);
    }

    // Everything the model offered was unusable: nothing valid remains.
    if (todos.length === 0 && gaps.length === 0) return null;
    return { ...draft, todos, gaps };
  } catch {
    return null;
  }
}

// ---- brief ----

export interface BriefGap {
  readonly blockIndex: number;
  readonly start: string;
  readonly end: string;
  /** The model's suggestion; absent in a fallback brief (nothing is invented). */
  readonly suggestion?: string;
}

export interface BriefTodoItem {
  readonly id: number;
  readonly text: string;
  readonly due: string | null;
  readonly bill: boolean;
  /** The model's first step; absent in a fallback brief (nothing is invented). */
  readonly firstStep?: string;
}

export interface Brief {
  readonly source: 'model' | 'fallback';
  readonly dayLine: string;
  readonly stateLine?: string;
  readonly gaps: readonly BriefGap[];
  readonly todos: readonly BriefTodoItem[];
  /** Present only when the model wrote one; the fallback never invents encouragement. */
  readonly encouragement?: string;
}

/** Attach the validated draft to the input it was allowed to reference. */
export function toBrief(draft: BriefDraft, input: WriterInput): Brief {
  const gaps: BriefGap[] = draft.gaps.map((gap) => {
    const block = input.blocks[gap.blockIndex]!;
    return { blockIndex: gap.blockIndex, start: block.start, end: block.end, suggestion: gap.suggestion };
  });
  const todos: BriefTodoItem[] = draft.todos.map((todo) => {
    const candidate = input.todos.find((item) => item.id === todo.id)!;
    return { id: todo.id, text: candidate.text, due: candidate.due, bill: candidate.bill, firstStep: todo.firstStep };
  });
  return {
    source: 'model',
    dayLine: draft.dayLine,
    ...(draft.stateLine !== undefined ? { stateLine: draft.stateLine } : {}),
    gaps,
    todos,
    encouragement: draft.encouragement,
  };
}

/** Deterministic render of the same input: top 3 todos (no firstStep), free blocks, and state flags as plain words. */
export function fallbackBrief(input: WriterInput): Brief {
  const stateWords = input.state.flags.map((flag) => `${FLAG_LABEL[flag.key]} ${flag.compare} its 30-day median`);
  if (input.state.low) stateWords.push('state is low');
  return {
    source: 'fallback',
    dayLine: `${input.day}: ${input.blocks.length} free block(s), ${input.todos.length} todo candidate(s).`,
    ...(stateWords.length ? { stateLine: stateWords.join('; ') } : {}),
    gaps: input.blocks.map((block, blockIndex) => ({ blockIndex, start: block.start, end: block.end })),
    todos: input.todos.slice(0, 3).map((todo) => ({ id: todo.id, text: todo.text, due: todo.due, bill: todo.bill })),
  };
}
