// The single JSON file written by the Morning Brief cron (ADR-0046). Pure domain code: the schema is re-validated on
// every read, and serialisation is deterministic (stable key order, one trailing newline).
import { z } from 'zod';
import { ErrorCode } from '@vault-companion/contracts';

export const BRIEF_FILE_SCHEMA_VERSION = 2;

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
  overdueDays: z.number().int().positive().optional(),
});

const Meeting = z.object({
  title: z.string(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  allDay: z.boolean(),
  clash: z.boolean(),
  clashWith: z.string().optional(),
  link: z.string().optional().transform((link) => {
    if (!link) return undefined;
    try {
      const url = new URL(link);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        (url.hostname === 'calendar.google.com' || (url.hostname === 'www.google.com' && url.pathname.startsWith('/calendar/')))
        ? link : undefined;
    } catch { return undefined; }
  }).optional(),
});

const Brief = z.object({
  source: z.enum(['model', 'fallback']),
  dayLine: z.string(),
  stateLine: z.string().optional(),
  meetings: z.array(Meeting).default([]),
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
    unavailableReasons: z.record(z.string(), z.union([ErrorCode, z.literal('threw')])).default({}),
    brief: Brief,
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value.unavailableReasons).some((name) => !value.unavailable.includes(name))) {
      ctx.addIssue({ code: 'custom', message: 'reason names must match unavailable' });
    }
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
  if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion === 1) {
    value = { ...value, schemaVersion: 2, unavailableReasons: {},
      ...('brief' in value && typeof value.brief === 'object' && value.brief !== null
        ? { brief: { ...value.brief, meetings: [] } } : {}) };
  }
  const parsed = BriefFile.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Deterministic JSON bytes: stable key order, two-space indentation, one trailing newline. */
export function serializeBriefFile(file: BriefFile): Uint8Array {
  file = BriefFile.parse(file);
  const brief = {
    source: file.brief.source,
    dayLine: file.brief.dayLine,
    ...(file.brief.stateLine !== undefined ? { stateLine: file.brief.stateLine } : {}),
    meetings: file.brief.meetings.map((meeting) => ({
      title: meeting.title, start: meeting.start, end: meeting.end, allDay: meeting.allDay, clash: meeting.clash,
      ...(meeting.clashWith !== undefined ? { clashWith: meeting.clashWith } : {}),
      ...(meeting.link !== undefined ? { link: meeting.link } : {}),
    })),
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
      ...(todo.overdueDays !== undefined ? { overdueDays: todo.overdueDays } : {}),
      ...(todo.firstStep !== undefined ? { firstStep: todo.firstStep } : {}),
    })),
    ...(file.brief.encouragement !== undefined ? { encouragement: file.brief.encouragement } : {}),
  };
  const json = {
    schemaVersion: BRIEF_FILE_SCHEMA_VERSION,
    date: file.date,
    generatedAt: file.generatedAt,
    source: file.source,
    unavailable: file.unavailable,
    unavailableReasons: Object.fromEntries(Object.entries(file.unavailableReasons).sort(([a], [b]) => a.localeCompare(b))),
    brief,
  };
  return new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`);
}
