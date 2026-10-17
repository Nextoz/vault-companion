// M6a: wire contract for the vault activity (heatmap) JSON a vault-side PC script emits at one fixed path. The
// file is re-validated on every read; no day, area name or count is ever client input.
import { z } from 'zod';

const isoInstant = z.iso.datetime({ offset: true });
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
const count = z.number().int().nonnegative();
const jobStage = z.enum(['saved', 'applied', 'interview', 'offer', 'closed', 'other']);

/** One day of the window: distinct notes touched that day, counted by top-level area. */
export const VaultActivityDay = z.strictObject({ date: isoDay, notes: count, areas: z.record(z.string(), count) });
export type VaultActivityDay = z.infer<typeof VaultActivityDay>;

/**
 * The file shape on disk (schema 1). Strict: an unknown or malformed key fails the whole file — the script is
 * versioned with the reader, so anything else is a broken write, never a half-read heatmap.
 */
export const VaultActivityFile = z.strictObject({
  schema: z.literal(1),
  generatedAt: isoInstant,
  source: z.string(),
  windowDays: count,
  start: isoDay,
  end: isoDay,
  days: z.array(VaultActivityDay).max(400),
  currentStreak: count,
  notesThisMonth: count,
  areas30d: z.array(z.strictObject({ area: z.string(), notes: count })).max(100),
  excluded: z.array(z.string()).max(100),
});
export type VaultActivityFile = z.infer<typeof VaultActivityFile>;

/** `Automation/Monitors/vault-activity.json`, projected read-only, plus the commit the read was pinned to. */
export const VaultActivityResponse = VaultActivityFile.extend({ revision: commitSha });
export type VaultActivityResponse = z.infer<typeof VaultActivityResponse>;

// M5a: wire contract for the job radar JSON a vault-side PC script emits at one fixed path from Job Search
// frontmatter. The file is re-validated on every read; no title, status or file path is ever client input.

/** One in-flight application: its note, pipeline stage and freshness. */
export const JobRadarItem = z.strictObject({
  title: z.string(),
  file: z.string(),
  status: z.string().nullable(),
  stage: jobStage,
  updated: isoDay.nullable(),
  daysSinceUpdate: z.number().int().nullable(),
});
export type JobRadarItem = z.infer<typeof JobRadarItem>;

/** One dated follow-up, e.g. a `follow_up` or `review_due` frontmatter field. */
export const JobRadarFollowUp = z.strictObject({
  title: z.string(),
  stage: jobStage,
  due: isoDay,
  field: z.string(),
  overdue: z.boolean(),
});
export type JobRadarFollowUp = z.infer<typeof JobRadarFollowUp>;

/** The file shape on disk (schema 1). Strict, like the activity file: an unknown key is a broken write. */
export const JobRadarFile = z.strictObject({
  schema: z.literal(1),
  generatedAt: isoInstant,
  source: z.string(),
  total: count,
  counts: z.strictObject({
    saved: count,
    applied: count,
    interview: count,
    offer: count,
    closed: count,
    other: count,
  }),
  otherStatuses: z.array(z.string()).max(50),
  inFlight: z.array(JobRadarItem).max(200),
  followUps: z.array(JobRadarFollowUp).max(100),
  stageTable: z.record(z.string(), z.string()),
  applicationTypes: z.array(z.string()).max(20),
});
export type JobRadarFile = z.infer<typeof JobRadarFile>;

/** `Automation/Monitors/job-radar.json`, projected read-only, plus the commit the read was pinned to. */
export const JobRadarResponse = JobRadarFile.extend({ revision: commitSha });
export type JobRadarResponse = z.infer<typeof JobRadarResponse>;
