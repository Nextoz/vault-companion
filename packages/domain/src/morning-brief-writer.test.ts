import { describe, expect, it } from 'vitest';
import type { HealthMetric, WeatherRunWindow } from '@vault-companion/contracts';
import { stateLine, type BriefTodo, type FreeBlock } from './morning-brief.ts';
import {
  buildWriterInput,
  buildWriterPrompt,
  fallbackBrief,
  parseWriterOutput,
  toBrief,
  WRITER_SYSTEM_PROMPT,
  type WriterInput,
} from './morning-brief-writer.ts';

// All data synthetic.
const DAY = '2026-06-15';
const block = (start: string, end: string, minutes: number): FreeBlock => ({
  start,
  end,
  minutes,
  long: minutes >= 90,
});
const metric = (over: Partial<HealthMetric>): HealthMetric => ({ key: 'steps', value: null, baseline: null, compare: 'unknown', series: [], ...over });
const todo = (text: string, over: Partial<BriefTodo> = {}): BriefTodo => ({ text, due: null, bill: false, ...over });

const BLOCKS = [
  block('2026-06-15T05:00:00.000Z', '2026-06-15T07:00:00.000Z', 120),
  block('2026-06-15T07:00:00.000Z', '2026-06-15T07:10:00.000Z', 10),
];

function makeInput(todos: BriefTodo[] = [todo('SENTINEL-CANDIDATE-A', { due: DAY }), todo('SENTINEL-CANDIDATE-B')]): WriterInput {
  const state = stateLine([metric({ key: 'steps', value: 987654, baseline: 8000, compare: 'below' })], { mood: -3, energy: 1, sleep: 7 });
  return buildWriterInput({
    day: DAY,
    blocks: BLOCKS,
    todos,
    state,
    weatherWindows: [] as WeatherRunWindow[],
    trainingRecent: { count: 2, dates: ['2026-06-14', '2026-06-15'] },
    unavailable: ['mail'],
  });
}

const draft = (over: Record<string, unknown> = {}) => ({
  dayLine: 'A short day with room to breathe.',
  stateLine: 'Steps are below your usual.',
  gaps: [{ blockIndex: 0, suggestion: 'Take a walk in the long block.' }],
  todos: [{ id: 0, firstStep: 'Open the letter.' }],
  encouragement: 'One step is enough.',
  ...over,
});

describe('buildWriterInput', () => {
  it('ranks todos and numbers the candidates from 0, dropping the rest', () => {
    const input = makeInput([
      todo('SENTINEL-NON-CANDIDATE-D', { due: null }),
      todo('SENTINEL-NON-CANDIDATE-C', { due: null }),
      todo('SENTINEL-CANDIDATE-B', { due: DAY }),
      todo('SENTINEL-CANDIDATE-A', { due: DAY }),
      todo('SENTINEL-CANDIDATE-0', { bill: true }),
    ]);
    expect(input.todos.map((t) => t.text)).toEqual(['SENTINEL-CANDIDATE-B', 'SENTINEL-CANDIDATE-A', 'SENTINEL-CANDIDATE-0']);
    expect(input.todos.map((t) => t.id)).toEqual([0, 1, 2]);
  });
});

describe('buildWriterPrompt', () => {
  it('carries derived flags and labels, never raw metric values', () => {
    const { system, user } = buildWriterPrompt(makeInput());
    expect(system).toBe(WRITER_SYSTEM_PROMPT);
    expect(user).toContain('steps below its 30-day median');
    expect(user).toContain('mood -3, energy 1, sleep 7');
    expect(user).not.toContain('987654');
    expect(user).not.toContain('8000');
  });

  it('carries only candidate todo text and never the ranked-out candidate', () => {
    const { user } = buildWriterPrompt(makeInput());
    expect(user).toContain('SENTINEL-CANDIDATE-A');
    expect(user).not.toContain('SENTINEL-NON-CANDIDATE');
  });

  it('states the low-state rule in the system prompt', () => {
    expect(WRITER_SYSTEM_PROMPT).toMatch(/state is low[\s\S]*fewer items/i);
  });
});

describe('parseWriterOutput', () => {
  it('parses a plain JSON reply', () => {
    expect(parseWriterOutput(JSON.stringify(draft()), makeInput())).toMatchObject({
      dayLine: 'A short day with room to breathe.',
      todos: [{ id: 0, firstStep: 'Open the letter.' }],
    });
  });

  it('tolerates a fenced JSON reply', () => {
    const parsed = parseWriterOutput('```json\n' + JSON.stringify(draft()) + '\n```', makeInput());
    expect(parsed?.gaps).toEqual([{ blockIndex: 0, suggestion: 'Take a walk in the long block.' }]);
  });

  it('drops unknown todo ids and gaps on short blocks', () => {
    const parsed = parseWriterOutput(
      JSON.stringify(draft({ todos: [{ id: 0, firstStep: 'Real.' }, { id: 9, firstStep: 'Unknown.' }], gaps: [{ blockIndex: 0, suggestion: 'Long.' }, { blockIndex: 1, suggestion: 'Short.' }] })),
      makeInput(),
    );
    expect(parsed?.todos).toEqual([{ id: 0, firstStep: 'Real.' }]);
    expect(parsed?.gaps).toEqual([{ blockIndex: 0, suggestion: 'Long.' }]);
  });

  it('drops duplicate ids and duplicate gaps', () => {
    const parsed = parseWriterOutput(
      JSON.stringify(draft({ todos: [{ id: 0, firstStep: 'A.' }, { id: 0, firstStep: 'B.' }], gaps: [{ blockIndex: 0, suggestion: 'A.' }, { blockIndex: 0, suggestion: 'B.' }] })),
      makeInput(),
    );
    expect(parsed?.todos).toHaveLength(1);
    expect(parsed?.gaps).toHaveLength(1);
  });

  it('keeps at most 3 todos', () => {
    const wide: WriterInput = { ...makeInput(), todos: [0, 1, 2, 3].map((id) => ({ id, text: `T${id}`, due: null, bill: false })) };
    const parsed = parseWriterOutput(JSON.stringify(draft({ todos: [0, 1, 2, 3].map((id) => ({ id, firstStep: `S${id}` })) })), wide);
    expect(parsed?.todos.map((t) => t.id)).toEqual([0, 1, 2]);
  });

  it('returns null for garbage, empty and out-of-contract replies', () => {
    expect(parseWriterOutput('', makeInput())).toBeNull();
    expect(parseWriterOutput('   ', makeInput())).toBeNull();
    expect(parseWriterOutput('not json at all', makeInput())).toBeNull();
    expect(parseWriterOutput('{"dayLine":"x"}', makeInput())).toBeNull();
    expect(parseWriterOutput(JSON.stringify(draft({ todos: [], gaps: [] })), makeInput())).toBeNull();
    expect(parseWriterOutput(JSON.stringify(draft({ todos: [{ id: 9, firstStep: 'Unknown.' }], gaps: [{ blockIndex: 1, suggestion: 'Short.' }] })), makeInput())).toBeNull();
  });
});

describe('toBrief', () => {
  it('echoes the referenced block and candidate, marking the source as the model', () => {
    const input = makeInput();
    const parsed = parseWriterOutput(JSON.stringify(draft()), input)!;
    const brief = toBrief(parsed, input);
    expect(brief.source).toBe('model');
    expect(brief.gaps[0]).toMatchObject({ blockIndex: 0, start: BLOCKS[0]!.start, end: BLOCKS[0]!.end });
    expect(brief.todos[0]).toMatchObject({ id: 0, text: 'SENTINEL-CANDIDATE-A', due: DAY, firstStep: 'Open the letter.' });
  });
});

describe('fallbackBrief', () => {
  it('is deterministic and never invents text', () => {
    const input = makeInput();
    const first = fallbackBrief(input);
    expect(first).toEqual(fallbackBrief(input));
    expect(first.source).toBe('fallback');
    expect(first.encouragement).toBeUndefined();
    expect(first.todos.every((t) => t.firstStep === undefined)).toBe(true);
    expect(first.todos.map((t) => t.text)).toEqual(input.todos.slice(0, 3).map((t) => t.text));
    expect(first.gaps.map((g) => g.blockIndex)).toEqual([0, 1]);
    expect(first.stateLine).toContain('steps below its 30-day median');
  });
});
