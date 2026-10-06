// Daily Morning Brief cron (ADR-0046): 06:xx Europe/Copenhagen → gather candidates → phrase (or fallback) → commit
// exactly `Daily/Morning Digest/Morning Brief - latest.json`. Logs carry only allowlisted fields; no brief text or key.
import {
  buildWriterInput,
  commitMorningBrief,
  fallbackBrief,
  freeBlocks,
  findClashes,
  MORNING_BRIEF_PATH,
  MORNING_BRIEF_STATUS_COMMIT_COST,
  morningBriefOperationId,
  parseBriefFile,
  parseVaultPath,
  stateLine,
  userDate,
  writeMorningBriefStatus,
  type BriefFile,
  type MorningBriefOutcome,
  type VaultStore,
} from '@vault-companion/domain';
import { diagnosticDetail, sanitize, type LogSink } from './log.ts';
import { renderBriefEmail, type BriefMailer } from './morning-brief-email.ts';
import type { MorningBriefCandidates } from './morning-brief-gather.ts';
import { writeBrief, type ScalewayChat } from './scaleway-chat.ts';

export const BRIEF_ROUTE = 'cron:morning-brief';
/** ADR-0046/0055: 04:30/05:30 UTC cover Copenhagen 06:31 across DST; 31 6 UTC is the catch-up (07:31 summer / 07:31 winter, Workers Free allows 5 crons per account). */
export const BRIEF_CRONS = {
  summer: '31 4 * * *',
  winter: '31 5 * * *',
  summerCatchup: '31 6 * * *',
} as const;
export type BriefSlot = keyof typeof BRIEF_CRONS;
/** ADR-0055: a failed/late run retries on the catch-up crons; any Copenhagen hour 6..11 is a run window. */
const BRIEF_LOCAL_HOUR_START = 6;
const BRIEF_LOCAL_HOUR_END = 11;
export const BRIEF_SUBREQUEST_BUDGET = 45;

export function briefSlotForCron(cron: string): BriefSlot | null {
  return (Object.entries(BRIEF_CRONS).find(([, value]) => value === cron)?.[0] as BriefSlot | undefined) ?? null;
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
  /** Absent when the `send_email` binding or its from/to secrets are unset; the job then writes without emailing. */
  readonly mailer?: BriefMailer;
  readonly now: () => Date;
  readonly timeZone: string;
  readonly log: LogSink;
  /** Head already fetched by the caller; avoids one duplicate head read in the cron composition. */
  readonly baseRevision?: string;
  /** ADR-0055 test hook: skips only the local-hour guard. A plain var, never a secret. */
  readonly anyHour?: boolean;
  readonly subrequests?: () => number;
  readonly budget?: number;
}

export async function runBriefJob(cron: string, deps: BriefJobDeps): Promise<void> {
  const started = Date.now();
  const base = { requestId: crypto.randomUUID(), method: 'CRON', route: BRIEF_ROUTE, commandType: 'morning-brief' };
  if (!briefSlotForCron(cron)) {
    deps.log(sanitize({ ...base, status: 400, durationMs: 0, errorCode: 'unknown-cron' }));
    return;
  }
  const now = deps.now();
  const hour = localHour(now, deps.timeZone);
  if (!deps.anyHour && (hour < BRIEF_LOCAL_HOUR_START || hour > BRIEF_LOCAL_HOUR_END)) {
    deps.log(sanitize({ ...base, status: 204, durationMs: 0, errorCode: 'skipped' }));
    return;
  }

  const date = userDate(now, deps.timeZone);
  const operationId = await morningBriefOperationId(date);
  let outcome: MorningBriefOutcome = 'internal';
  let unavailable: string[] = [];
  let unavailableCodes: MorningBriefCandidates['unavailableCodes'] = {};
  let source: 'model' | 'fallback' = 'fallback';
  let errorCode: string | null = 'internal';

  // Fixed per-reader codes only: an empty map adds no fact, so clean runs log nothing extra.
  const codesFact = (): { readonly unavailableCodes?: Readonly<Record<string, string>> } =>
    Object.keys(unavailableCodes).length > 0 ? { unavailableCodes } : {};

  try {
    const path = parseVaultPath(MORNING_BRIEF_PATH);
    if (path) {
      const baseRevision = deps.baseRevision ?? (await deps.store.head()).commitSha;
      const existing = await deps.store.readFile(path, baseRevision);
      if (existing) {
        const current = parseBriefFile(existing.bytes);
        if (!current) {
          outcome = 'not-written';
          errorCode = 'not-written:unreadable';
          deps.log(sanitize({ ...base, status: 503, durationMs: 0, errorCode: 'not-written:unreadable' }));
        } else if (current.date === date) {
          outcome = 'already-written';
          errorCode = null;
          deps.log(sanitize({ ...base, status: 204, durationMs: 0, errorCode: 'already-written' }));
        }
      }
    }

    if (outcome === 'internal') {
      const candidates = await deps.gather(date);
      unavailable = [...candidates.unavailable];
      unavailableCodes = { ...candidates.unavailableCodes };
      const meetings = findClashes(candidates.events);
      const input = buildWriterInput({
        day: date,
        blocks: unavailable.includes('calendar') ? [] : freeBlocks(candidates.events, date, deps.timeZone),
        calendar: { count: meetings.length, firstStart: meetings[0]?.start ?? null, clashCount: meetings.filter((meeting) => meeting.clash).length },
        unavailableReasons: unavailableCodes,
        todos: candidates.todos,
        state: stateLine(candidates.metrics, candidates.mood),
        weatherWindows: candidates.weatherWindows,
        trainingRecent: candidates.trainingRecent,
        unavailable,
      });
      const brief = deps.chat ? await writeBrief(input, deps.chat) : fallbackBrief(input);
      source = brief.source;
      const file: BriefFile = {
        schemaVersion: 2,
        date,
        generatedAt: now.toISOString(),
        source: brief.source,
        unavailable: [...input.unavailable],
        unavailableReasons: { ...unavailableCodes },
        brief: {
          meetings,
          source: brief.source,
          dayLine: brief.dayLine,
          ...(brief.stateLine !== undefined ? { stateLine: brief.stateLine } : {}),
          gaps: [...brief.gaps],
          todos: [...brief.todos],
          ...(brief.encouragement !== undefined ? { encouragement: brief.encouragement } : {}),
        },
      };
      const result = await commitMorningBrief({ store: deps.store, operationId, file });
      const durationMs = Date.now() - started;
      if (result.kind === 'committed') {
        outcome = 'committed';
        errorCode = null;
        deps.log(sanitize({ ...base, status: 200, durationMs, operationId: result.operationId, commitSha: result.commitSha, ...codesFact() }));
        if (deps.mailer) {
          // Delivery is best-effort: a send failure is logged but never fails or rolls back the committed brief.
          try {
            await deps.mailer.send(renderBriefEmail(file));
          } catch {
            deps.log(sanitize({
              ...base,
              status: 200,
              durationMs: Date.now() - started,
              operationId: result.operationId,
              commitSha: result.commitSha,
              errorCode: 'email-failed',
              ...codesFact(),
            }));
          }
        }
      } else if (result.kind === 'already-written') {
        outcome = 'already-written';
        errorCode = null;
        deps.log(sanitize({ ...base, status: 204, durationMs, operationId: result.operationId, errorCode: 'already-written', ...codesFact() }));
      } else {
        outcome = 'not-written';
        errorCode = `not-written:${result.reason}`;
        deps.log(sanitize({ ...base, status: 503, durationMs, errorCode: `not-written:${result.reason}`, ...codesFact() }));
      }
    }
  } catch (err) {
    outcome = 'internal';
    errorCode = 'internal';
    const detail = diagnosticDetail(err);
    deps.log(sanitize({
      ...base,
      status: 500,
      durationMs: Date.now() - started,
      errorCode: 'internal',
      errorClass: err instanceof Error ? err.name : 'unknown',
      ...(detail ? { errorDetail: detail } : {}),
    }));
  } finally {
    const budget = deps.budget ?? BRIEF_SUBREQUEST_BUDGET;
    if (deps.subrequests && deps.subrequests() + MORNING_BRIEF_STATUS_COMMIT_COST > budget) {
      deps.log(sanitize({ ...base, status: 503, durationMs: Date.now() - started, errorCode: 'status-not-written:budget', ...codesFact() }));
    } else {
      try {
        const statusResult = await writeMorningBriefStatus({
          store: deps.store,
          facts: { nowIso: now.toISOString(), operationId, outcome, unavailable, source, errorCode },
        });
        if (statusResult.kind !== 'committed') {
          deps.log(sanitize({ ...base, status: 503, durationMs: Date.now() - started, errorCode: `status-not-written:${statusResult.reason}`, ...codesFact() }));
        }
      } catch (statusErr) {
        const detail = diagnosticDetail(statusErr);
        deps.log(sanitize({
          ...base,
          status: 503,
          durationMs: Date.now() - started,
          errorCode: 'status-not-written:internal',
          errorClass: statusErr instanceof Error ? statusErr.name : 'unknown',
          ...(detail ? { errorDetail: detail } : {}),
          ...codesFact(),
        }));
      }
    }
  }
}
