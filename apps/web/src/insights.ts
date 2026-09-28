import type { ScoutStatus } from '@vault-companion/contracts';
import MarkdownIt from 'markdown-it';
import { hasEvenScoutTableRows, hasRegularScoutTableShape } from './note/scout-table.ts';

export type InsightPick = { text: string; details: string[]; link?: string | undefined };
export type TrendDay = { date: string; findings: number | null };

const parser = MarkdownIt({ html: false });
type Token = ReturnType<typeof parser.parse>[number];
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
});

function dayKey(value: string | number): string | null {
  const instant = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const parts = Object.fromEntries(dayFormatter.formatToParts(instant).map(({ type, value: part }) => [type, part]));
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
}

function plain(inline: Token): string {
  const text = inline.children?.filter((token) => ['text', 'code_inline', 'image'].includes(token.type))
    .map((token) => token.content).join(' ') ?? inline.content;
  return text.replace(/\s+/g, ' ').trim();
}

function firstLink(inline: Token): string | undefined {
  for (const token of inline.children ?? []) {
    if (token.type === 'link_open') { const href = token.attrGet('href'); return typeof href === 'string' ? href : undefined; }
  }
  return undefined;
}

export function topPicks(markdown: string, n = 3): InsightPick[] {
  if (n <= 0) return [];
  const source = markdown.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const tokens = parser.parse(source, {});
  for (let index = 0; index < tokens.length; index++) {
    const open = tokens[index]!;
    if (open.type !== 'table_open' || !open.map || !hasEvenScoutTableRows(lines, open.map)) continue;
    const headers: string[] = [];
    const rows: InsightPick[] = [];
    const tableRows: string[][] = [];
    let section: 'head' | 'body' | null = null;
    let cells: { text: string; link?: string | undefined }[] | null = null;
    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor]!.type !== 'table_close'; cursor++) {
      const token = tokens[cursor]!;
      if (token.type === 'thead_open') section = 'head';
      if (token.type === 'tbody_open') section = 'body';
      if (token.type === 'tr_open') cells = [];
      if (token.type === 'inline' && cells) cells.push({ text: plain(token), link: firstLink(token) });
      if (token.type === 'tr_close' && cells) {
        if (section === 'head') headers.push(...cells.map((cell) => cell.text));
        else if (section === 'body') {
          tableRows.push(cells.map((cell) => cell.text));
          if (cells[0]?.text) rows.push({
            text: cells[0].text,
            details: cells.slice(1, 3).filter((cell) => cell.text).map((cell, cellIndex) => `${headers[cellIndex + 1]}: ${cell.text}`),
            link: cells.find((cell) => cell.link)?.link,
          });
        }
        cells = null;
      }
    }
    if (hasRegularScoutTableShape(headers, tableRows)) return rows.slice(0, n);
  }

  const picks: InsightPick[] = [];
  let listDepth = 0;
  let itemDepth = 0;
  let current: InsightPick | null = null;
  for (const token of tokens) {
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') listDepth++;
    else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') { if (--listDepth === 0) break; }
    else if (token.type === 'list_item_open' && listDepth === 1) { itemDepth = token.level; current = { text: '', details: [] }; }
    else if (token.type === 'inline' && current && listDepth === 1 && token.level > itemDepth) {
      const text = plain(token);
      if (text) current.text = current.text ? `${current.text} ${text}` : text;
      current.link ??= firstLink(token);
    } else if (token.type === 'list_item_close' && current && token.level === itemDepth) {
      if (current.text) picks.push(current);
      current = null;
      if (picks.length === n) break;
    }
  }
  return picks;
}

function successfulRuns(status: ScoutStatus) {
  const runs = status.history.filter((run) => run.status === 'success');
  if (status.runStatus === 'success' && status.lastSuccessAt &&
      !runs.some((run) => run.at === status.lastSuccessAt)) {
    runs.push({ at: status.lastSuccessAt, status: 'success', findings: status.findings });
  }
  return runs;
}

export function findingsTrend(statuses: readonly ScoutStatus[], now: string | number, days = 7): TrendDay[] {
  if (days <= 0) return [];
  const today = dayKey(now);
  if (!today) return [];
  const [year, month, date] = today.split('-').map(Number) as [number, number, number];
  const keys = Array.from({ length: days }, (_, index) => {
    const day = new Date(Date.UTC(year, month - 1, date - (days - 1 - index)));
    return day.toISOString().slice(0, 10);
  });
  const totals = new Map(keys.map((key) => [key, [] as number[]]));
  for (const status of statuses) {
    const latest = new Map<string, (typeof status.history)[number]>();
    for (const run of successfulRuns(status)) {
      const key = dayKey(run.at);
      if (key && totals.has(key) && (!latest.has(key) || Date.parse(run.at) > Date.parse(latest.get(key)!.at))) latest.set(key, run);
    }
    for (const [key, run] of latest) if (run.findings !== null) totals.get(key)!.push(run.findings);
  }
  return keys.map((date) => ({ date, findings: totals.get(date)!.length ? totals.get(date)!.reduce((sum, value) => sum + value, 0) : null }));
}

export function overview(statuses: readonly ScoutStatus[]) {
  let totalFindings = 0;
  let latestSuccessAt: string | null = null;
  const noSuccess: string[] = [];
  const byScout = new Map<string, { findings: number; at: string }>();
  for (const status of statuses) {
    const run = successfulRuns(status).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (!run || run.findings === null) { noSuccess.push(status.scoutId); continue; }
    totalFindings += run.findings;
    byScout.set(status.scoutId, { findings: run.findings, at: run.at });
    if (!latestSuccessAt || Date.parse(run.at) > Date.parse(latestSuccessAt)) latestSuccessAt = run.at;
  }
  return { totalFindings, latestSuccessAt, noSuccess, byScout };
}
