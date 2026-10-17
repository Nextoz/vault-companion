// M5b: projection of the job radar file into what the radar card draws. Pure: no React, no clock of its own.
// Stage bars are sized against the widest stage, not the total, so one big bucket cannot flatten the pipeline.
import type { JobRadarResponse } from '@vault-companion/contracts';

const ZONE = 'Europe/Copenhagen';
/** The producer runs daily; a file older than this has missed a run and is shown as stale. */
export const JOB_RADAR_STALE_MS = 26 * 60 * 60 * 1000;
export const JOB_RADAR_IN_FLIGHT_LIMIT = 6;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type RadarStageName = 'saved' | 'applied' | 'interview' | 'offer' | 'closed' | 'other';
export interface RadarStage { stage: RadarStageName; label: string; count: number; share: number }
export interface RadarInFlight { title: string; stage: RadarStageName; ageLabel: string }
export interface RadarFollowUp { title: string; due: string; overdue: boolean; label: 'overdue' | 'due soon' }
export interface JobRadarView {
  summary: string;
  stages: RadarStage[];
  inFlight: RadarInFlight[];
  followUps: RadarFollowUp[];
  otherNote: string | null;
  stale: boolean;
  footer: string;
}

/** The five pipeline columns in display order; `other` is appended by the projector only when it has notes. */
const STAGES: ReadonlyArray<{ stage: Exclude<RadarStageName, 'other'>; label: string }> = [
  { stage: 'saved', label: 'Saved' },
  { stage: 'applied', label: 'Applied' },
  { stage: 'interview', label: 'Interview' },
  { stage: 'offer', label: 'Offer' },
  { stage: 'closed', label: 'Closed' },
];

/** `2026-10-14` → `14 Oct`, straight from the calendar day (no time zone involved). */
function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]!}`;
}

function ageLabel(days: number | null): string {
  if (days === null) return 'Update date unknown';
  if (days === 0) return 'Updated today';
  return `Updated ${days} days ago`;
}

function freshness(generatedAt: string, stale: boolean): string {
  const at = new Date(generatedAt);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  if (!stale) return `Job Search 2026 notes · Updated ${time}`;
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, day: 'numeric', month: 'short' }).format(at);
  return `Job Search 2026 notes · Stale · Updated ${day} ${time}`;
}

export function projectJobRadar(res: JobRadarResponse, nowMs: number): JobRadarView {
  const counts = res.counts;
  const max = Math.max(counts.saved, counts.applied, counts.interview, counts.offer, counts.closed, counts.other);
  const share = (n: number) => (max > 0 ? n / max : 0);
  const stages: RadarStage[] = STAGES.map(({ stage, label }) => ({ stage, label, count: counts[stage], share: share(counts[stage]) }));
  if (counts.other > 0) stages.push({ stage: 'other', label: 'Other', count: counts.other, share: share(counts.other) });

  const followUps = res.followUps.map((f): RadarFollowUp => ({
    title: f.title, due: dayLabel(f.due), overdue: f.overdue, label: f.overdue ? 'overdue' : 'due soon',
  }));
  const inFlight = res.inFlight.slice(0, JOB_RADAR_IN_FLIGHT_LIMIT).map((i): RadarInFlight => ({
    title: i.title, stage: i.stage, ageLabel: ageLabel(i.daysSinceUpdate),
  }));
  const interviews = counts.interview === 1 ? '1 interview' : `${counts.interview} interviews`;
  const followUpNote = followUps.length === 1 ? '1 follow-up' : `${followUps.length} follow-ups`;

  const stale = nowMs - Date.parse(res.generatedAt) > JOB_RADAR_STALE_MS;
  return {
    summary: `${counts.applied} applied · ${interviews} · ${followUpNote}`,
    stages, inFlight, followUps,
    otherNote: counts.other > 0
      ? `${counts.other} with a status the table does not map: ${res.otherStatuses.join(', ')}`
      : null,
    stale,
    footer: freshness(res.generatedAt, stale),
  };
}
