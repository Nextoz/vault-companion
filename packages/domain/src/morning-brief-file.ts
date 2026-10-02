// The single JSON file written by the Morning Brief cron (ADR-0046). Pure domain code: the schema is re-validated on
// every read, and serialisation is deterministic (stable key order, one trailing newline).
import { z } from 'zod';

export const BRIEF_FILE_SCHEMA_VERSION = 1;

const BriefGap = z.object({
  blockIndex: z.number().int().nonnegative(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  suggestion: z.string().optional(),
});

const BriefTodo = z.object({
  id: z.number().int().nonnegative(),
  text: z.string(),
  due: z.iso.date().nullable(),
  bill: z.boolean(),
  firstStep: z.string().optional(),
});

const Brief = z.object({
  source: z.enum(['model', 'fallback']),
  dayLine: z.string(),
  stateLine: z.string().optional(),
  gaps: z.array(BriefGap),
  todos: z.array(BriefTodo),
  encouragement: z.string().optional(),
});

export const BriefFile = z
  .object({
    schemaVersion: z.literal(BRIEF_FILE_SCHEMA_VERSION),
    /** YYYY-MM-DD in Europe/Copenhagen. */
    date: z.iso.date(),
    generatedAt: z.iso.datetime({ offset: true }),
    source: z.enum(['model', 'fallback']),
    unavailable: z.array(z.string()),
    brief: Brief,
  })
  .superRefine((value, ctx) => {
    if (value.source !== value.brief.source) {
      ctx.addIssue({ code: 'custom', message: 'source must match brief.source' });
    }
  });
export type BriefFile = z.infer<typeof BriefFile>;

/** Validate and parse raw bytes/text/JSON into a `BriefFile`; never throws. */
export function parseBriefFile(raw: unknown): BriefFile | null {
  let value = raw;
  if (value instanceof Uint8Array) {
    try {
      value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = BriefFile.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Deterministic JSON bytes: stable key order, two-space indentation, one trailing newline. */
export function serializeBriefFile(file: BriefFile): Uint8Array {
  const brief = {
    source: file.brief.source,
    dayLine: file.brief.dayLine,
    ...(file.brief.stateLine !== undefined ? { stateLine: file.brief.stateLine } : {}),
    gaps: file.brief.gaps.map((gap) => ({
      blockIndex: gap.blockIndex,
      start: gap.start,
      end: gap.end,
      ...(gap.suggestion !== undefined ? { suggestion: gap.suggestion } : {}),
    })),
    todos: file.brief.todos.map((todo) => ({
      id: todo.id,
      text: todo.text,
      due: todo.due,
      bill: todo.bill,
      ...(todo.firstStep !== undefined ? { firstStep: todo.firstStep } : {}),
    })),
    ...(file.brief.encouragement !== undefined ? { encouragement: file.brief.encouragement } : {}),
  };
  const json = {
    schemaVersion: file.schemaVersion,
    date: file.date,
    generatedAt: file.generatedAt,
    source: file.source,
    unavailable: file.unavailable,
    brief,
  };
  return new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`);
}
