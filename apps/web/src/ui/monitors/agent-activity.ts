// M2b: projection of the agent activity file into what the agent activity card draws. Pure: no React, no clock
// of its own. The card is a one-glance digest: merged PRs, CI health, today's spend, and what needs a human.
import type { AgentActivityResponse } from '@vault-companion/contracts';

const ZONE = 'Europe/Copenhagen';
/** The producer runs on a short interval; a file older than this has missed a run and is shown as stale. */
export const AGENT_ACTIVITY_STALE_MS = 3 * 60 * 60 * 1000;
export const AGENT_OPEN_PR_LIMIT = 5;

export interface AgentMergedRow { number: number; title: string; meta: string; change: string }
export interface AgentOpenRow { number: number; title: string; meta: string; draft: boolean }
export interface AgentNeedsYouRow { at: string; text: string }
export interface AgentActivityView {
  summary: string;
  ciLabel: string;
  merged: AgentMergedRow[];
  open: AgentOpenRow[];
  spendLines: string[];
  needsYou: AgentNeedsYouRow[];
  needsYouStale: boolean;
  stale: boolean;
  footer: string;
}

function timeLabel(at: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

function dayMonthLabel(at: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, day: 'numeric', month: 'short' }).format(new Date(at));
}

function needsYouLabel(at: string): string {
  return `${dayMonthLabel(at)} ${timeLabel(at)}`;
}

/** CI as one word: running, green, failing or unknown (no run, or a conclusion we do not name). */
function ciState(res: AgentActivityResponse): string {
  const ci = res.ci;
  if (!ci) return 'CI unknown';
  if (ci.status !== 'completed') return 'CI running';
  if (ci.conclusion === 'success') return 'CI green';
  if (ci.conclusion === 'failure' || ci.conclusion === 'cancelled' || ci.conclusion === 'timed_out') return 'CI failing';
  return 'CI unknown';
}

/** The CI word plus the deploy job's own health, e.g. `CI green · deploy green`. */
function ciLabel(res: AgentActivityResponse): string {
  const deploy = res.ci?.deploy;
  if (!deploy) return ciState(res);
  return `${ciState(res)} · deploy ${deploy.status !== 'completed' ? 'running' : deploy.conclusion === 'success' ? 'green' : 'failing'}`;
}

function changeLabel(additions: number | null, deletions: number | null): string {
  if (additions === null || deletions === null) return '';
  return `+${additions} −${deletions}`;
}

/** Today's spend, one line per vendor, only the vendors that reported a value. */
function spendLines(res: AgentActivityResponse): string[] {
  const lines: string[] = [];
  if (res.spend.scalewayEur !== null) lines.push(`Scaleway EUR ${res.spend.scalewayEur.toFixed(2)} today`);
  if (res.spend.deepseekUsd !== null) lines.push(`DeepSeek $${res.spend.deepseekUsd.toFixed(2)} today`);
  if (res.spend.claudeWeekPercent !== null) lines.push(`Claude ${res.spend.claudeWeekPercent} % of week`);
  if (res.spend.relay !== null) lines.push(`GLM relay ~EUR ${res.spend.relay.estimatedEur.toFixed(2)} (${res.spend.relay.window})`);
  return lines.length > 0 ? lines : ['No spend recorded yet today.'];
}

function footer(generatedAt: string, stale: boolean): string {
  const time = timeLabel(generatedAt);
  if (!stale) return `GitHub · AI usage · Updated ${time}`;
  return `GitHub · AI usage · Stale · Updated ${dayMonthLabel(generatedAt)} ${time}`;
}

export function projectAgentActivity(res: AgentActivityResponse, nowMs: number): AgentActivityView {
  const merged = res.prs.merged.map((pr): AgentMergedRow => ({
    number: pr.number,
    title: pr.title,
    meta: `merged ${timeLabel(pr.mergedAt)}${pr.branch !== null ? ` · ${pr.branch}` : ''}`,
    change: changeLabel(pr.additions, pr.deletions),
  }));
  const open = res.prs.open.slice(0, AGENT_OPEN_PR_LIMIT).map((pr): AgentOpenRow => ({
    number: pr.number,
    title: pr.title,
    meta: `opened ${dayMonthLabel(pr.createdAt)}`,
    draft: pr.isDraft,
  }));
  const needsYou = res.needsYou.items.map((item): AgentNeedsYouRow => ({ at: needsYouLabel(item.at), text: item.text }));
  const k = needsYou.length;
  const needs = res.needsYou.stale ? 'action log stale' : k === 0 ? 'nothing needs you' : `${k} needs you`;
  const n = merged.length;
  const stale = nowMs - Date.parse(res.generatedAt) > AGENT_ACTIVITY_STALE_MS;
  return {
    summary: `${n} ${n === 1 ? 'PR merged' : 'PRs merged'} · ${ciState(res)} · ${needs}`,
    ciLabel: ciLabel(res),
    merged,
    open,
    spendLines: spendLines(res),
    needsYou,
    needsYouStale: res.needsYou.stale,
    stale,
    footer: footer(res.generatedAt, stale),
  };
}
