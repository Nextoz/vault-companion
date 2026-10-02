// Daily Morning Brief cron (ADR-0046): 06:xx Europe/Copenhagen → gather candidates → phrase (or fallback) → commit
// exactly `Daily/Morning Digest/Morning Brief - latest.json`. Logs carry only allowlisted fields; no brief text or key.
import {
  buildWriterInput,
  commitMorningBrief,
  fallbackBrief,
  MORNING_BRIEF_PATH,
  morningBriefOperationId,
  parseBriefFile,
  parseVaultPath,
  stateLine,
  userDate,
  type BriefFile,
  type VaultStore,
} from '@vault-companion/domain';
import { diagnosticDetail, sanitize, type LogSink } from './log.ts';
import type { MorningBriefCandidates } from './morning-brief-gather.ts';
import { writeBrief, type ScalewayChat } from './scaleway-chat.ts';

export const BRIEF_ROUTE = 'cron:morning-brief';
/** Two UTC slots cover Copenhagen 06:30 across DST: 04:30 UTC (summer) and 05:30 UTC (winter). */
export const BRIEF_CRONS = { summer: '30 4 * * *', winter: '30 5 * * *' } as const;
export type BriefSlot = keyof typeof BRIEF_CRONS;
const BRIEF_LOCAL_HOUR = 6;

export function briefSlotForCron(cron: string): BriefSlot | null {
  return cron === BRIEF_CRONS.summer ? 'summer' : cron === BRIEF_CRONS.winter ? 'winter' : null;
}

function localHour(instant: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant)
    .find((p) => p.type === 'hour');
  return part ? Number(part.value) : Number.NaN;
}

export interface BriefJobDeps {
  readonly store: VaultStore;
  readonly gather: (day: string) => Promise<MorningBriefCandidates>;
  /** Absent when SCALEWAY_API_KEY is unset; the job then writes the deterministic fallback. */
  readonly chat?: ScalewayChat;
  readonly now: () => Date;
  readonly timeZone: string;
  readonly log: LogSink;
}

export async function runBriefJob(cron: string, deps: BriefJobDeps): Promise<void> {
  const started = Date.now();
  const base = { requestId: crypto.randomUUID(), method: 'CRON', route: BRIEF_ROUTE, commandType: 'morning-brief' };
  if (!briefSlotForCron(cron)) {
    deps.log(sanitize({ ...base, status: 400, durationMs: 0, errorCode: 'unknown-cron' }));
    return;
  }
  try {
    const now = deps.now();
    if (localHour(now, deps.timeZone) !== BRIEF_LOCAL_HOUR) {
      deps.log(sanitize({ ...base, status: 204, durationMs: 0, errorCode: 'skipped' }));
      return;
    }

    const date = userDate(now, deps.timeZone);
    const path = parseVaultPath(MORNING_BRIEF_PATH);
    if (path) {
      const { commitSha } = await deps.store.head();
      const existing = await deps.store.readFile(path, commitSha);
      if (existing) {
        const current = parseBriefFile(existing.bytes);
        if (!current) {
          deps.log(sanitize({ ...base, status: 503, durationMs: 0, errorCode: 'not-written:unreadable' }));
          return;
        }
        if (current.date === date) {
          deps.log(sanitize({ ...base, status: 204, durationMs: 0, errorCode: 'already-written' }));
          return;
        }
      }
    }

    const candidates = await deps.gather(date);
    const unavailable = [...candidates.unavailable, 'calendar', 'mail'];
    const input = buildWriterInput({
      day: date,
      blocks: [],
      todos: candidates.todos,
      state: stateLine(candidates.metrics, candidates.mood),
      weatherWindows: candidates.weatherWindows,
      trainingRecent: candidates.trainingRecent,
      unavailable,
    });
    const brief = deps.chat ? await writeBrief(input, deps.chat) : fallbackBrief(input);
    const file: BriefFile = {
      schemaVersion: 1,
      date,
      generatedAt: now.toISOString(),
      source: brief.source,
      unavailable: [...input.unavailable],
      brief: {
        source: brief.source,
        dayLine: brief.dayLine,
        ...(brief.stateLine !== undefined ? { stateLine: brief.stateLine } : {}),
        gaps: [...brief.gaps],
        todos: [...brief.todos],
        ...(brief.encouragement !== undefined ? { encouragement: brief.encouragement } : {}),
      },
    };
    const result = await commitMorningBrief({ store: deps.store, operationId: await morningBriefOperationId(date), file });
    const durationMs = Date.now() - started;
    if (result.kind === 'committed') {
      deps.log(sanitize({ ...base, status: 200, durationMs, operationId: result.operationId, commitSha: result.commitSha }));
    } else if (result.kind === 'already-written') {
      deps.log(sanitize({ ...base, status: 204, durationMs, operationId: result.operationId, errorCode: 'already-written' }));
    } else {
      deps.log(sanitize({ ...base, status: 503, durationMs, errorCode: `not-written:${result.reason}` }));
    }
  } catch (err) {
    const detail = diagnosticDetail(err);
    deps.log(sanitize({
      ...base,
      status: 500,
      durationMs: Date.now() - started,
      errorCode: 'internal',
      errorClass: err instanceof Error ? err.name : 'unknown',
      ...(detail ? { errorDetail: detail } : {}),
    }));
  }
}
