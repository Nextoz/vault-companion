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

// M2a: wire contract for the agent activity JSON a vault-side PC script emits at one fixed path. The file is
// re-validated on every read; no PR title, branch, token count or spend value is ever client input.

/** One pull request merged inside the window. */
export const AgentMergedPr = z.strictObject({
  number: z.number().int(),
  title: z.string(),
  mergedAt: isoInstant,
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  branch: z.string().nullable(),
  url: z.string(),
});
export type AgentMergedPr = z.infer<typeof AgentMergedPr>;

/** One pull request still open. */
export const AgentOpenPr = z.strictObject({
  number: z.number().int(),
  title: z.string(),
  createdAt: isoInstant,
  isDraft: z.boolean(),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  branch: z.string().nullable(),
  url: z.string(),
});
export type AgentOpenPr = z.infer<typeof AgentOpenPr>;

/** The latest CI run on the default branch, with its deploy job. */
export const AgentCi = z.strictObject({
  workflow: z.string().nullable(),
  runId: z.number().int().nullable(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  createdAt: isoInstant.nullable(),
  headSha: z.string().nullable(),
  url: z.string().nullable(),
  deploy: z
    .strictObject({
      name: z.string(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      completedAt: isoInstant.nullable(),
    })
    .nullable(),
});
export type AgentCi = z.infer<typeof AgentCi>;

/** Relay routing totals for the spend window. */
export const AgentRelay = z.strictObject({
  requests: z.number().int().nullable(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  estimatedEur: z.number(),
  window: z.string(),
});
export type AgentRelay = z.infer<typeof AgentRelay>;

/** One day of spend across vendors. */
export const AgentSpend = z.strictObject({
  date: isoDay,
  scalewayEur: z.number().nullable(),
  deepseekUsd: z.number().nullable(),
  claudeWeekPercent: z.number().nullable(),
  relay: AgentRelay.nullable(),
});
export type AgentSpend = z.infer<typeof AgentSpend>;

/** Items the agents flagged as needing a human decision. */
export const AgentNeedsYou = z.strictObject({
  logUpdatedAt: isoInstant.nullable(),
  stale: z.boolean(),
  items: z.array(z.strictObject({ at: isoInstant, text: z.string() })).max(50),
});
export type AgentNeedsYou = z.infer<typeof AgentNeedsYou>;

/** The file shape on disk (schema 1). Strict, like the other monitor files: an unknown key is a broken write. */
export const AgentActivityFile = z.strictObject({
  schema: z.literal(1),
  generatedAt: isoInstant,
  windowHours: z.number().int(),
  since: isoInstant,
  repo: z.string(),
  prs: z.strictObject({
    merged: z.array(AgentMergedPr).max(100),
    open: z.array(AgentOpenPr).max(100),
  }),
  ci: AgentCi.nullable(),
  spend: AgentSpend,
  needsYou: AgentNeedsYou,
  sourcesFailed: z.array(z.string()).max(10),
});
export type AgentActivityFile = z.infer<typeof AgentActivityFile>;

/** `Automation/Monitors/agent-activity.json`, projected read-only, plus the commit the read was pinned to. */
export const AgentActivityResponse = AgentActivityFile.extend({ revision: commitSha });
export type AgentActivityResponse = z.infer<typeof AgentActivityResponse>;
