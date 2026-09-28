// Daily research explainer (ADR-0029): pick today's papers from the research brief, have a model explain each one by
// URL, render validated JSON to Markdown, and commit all new notes plus the status record in ONE commit.
// Pure domain code: the model is behind `PaperExplainer`, the vault behind `VaultStore` (AGENTS rule 5).
import { ScoutStatus } from '@vault-companion/contracts';
import { z } from 'zod';
import { canWrite, EXPLAINED_DIR, EXPLAINER_STATUS_PATH, isExplainedNotePath, parseVaultPath } from './paths.ts';
import { gitBlobSha, StoreUnknownOutcome, TRAILER_OP, type VaultPath, type VaultStore } from './store.ts';
import { userDate } from './time.ts';

export const BRIEF_DIR = 'Research/Reading Briefs';
export const SCOUT_NOTE_DIR = 'Research/Daily Research Scout';
export const MAX_PAPERS_PER_DAY = 5;
/** ADR-0029 model chain, tried in order per paper. */
export const MODEL_CHAIN = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'] as const;
/**
 * ADR-0029 amendment: Workers Free allows 50 subrequests per invocation; ONE budget (with margin) covers every GitHub
 * and Gemini call of a run. Model calls stop when the rest could no longer pay for the commit.
 */
export const SUBREQUEST_BUDGET = 45;
/**
 * Worst-case GitHub requests of one multi-file write attempt with `files` files: an installation-token refresh, up to
 * three folder listings for preconditions (new folders), the base commit, one blob per file, tree, commit, ref.
 */
export const commitCost = (files: number): number => files + 7;
/** A re-plan after head-moved adds head, the status read and up to three listings. */
const REPLAN_COST = 5;
/** Write attempts (head-moved re-plans); a second one runs only if the budget still covers it. */
export const EXPLAINER_WRITE_ATTEMPTS = 2;
export const EXPLAINER_CRONS = { primary: '30 4 * * *', catchup: '30 6 * * *' } as const;
export type ExplainerSlot = keyof typeof EXPLAINER_CRONS;
export const EXPLAINER_SCOUT_ID = 'research-explainer';
export const TRAILER_JOB = 'Vault-Companion-Job';

export const briefPath = (date: string): string => `${BRIEF_DIR}/Research Reading Brief - ${date}.md`;
export const scoutNotePath = (date: string): string => `${SCOUT_NOTE_DIR}/Daily Research Scout - ${date}.md`;

export function slotForCron(cron: string): ExplainerSlot | null {
  return cron === EXPLAINER_CRONS.primary ? 'primary' : cron === EXPLAINER_CRONS.catchup ? 'catchup' : null;
}

// ---- input: the brief's (or scout note's) list items ----

export interface ReadingItem {
  /** The paper URL as written in the note (http/https only). */
  readonly url: string;
  /** Link text, when the item is a Markdown link; the note's slug comes from it. */
  readonly title: string | null;
  /** The item's own line minus the link: the scout's short "why". */
  readonly why: string;
}

const MAX_URL = 500;
const MAX_WHY = 500;

function cleanUrl(raw: string): string | null {
  const url = raw.replace(/[.,;:!?]+$/, '');
  if (url.length > MAX_URL || /[\s"'<>`\\]/.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Items under the exact `## <heading>` (until the next `#`/`##` heading), top-level list items only, first link per
 * item, in note order, distinct URLs, at most `MAX_PAPERS_PER_DAY`. Code fences are skipped.
 */
export function parseReadingItems(markdown: string, heading: string): ReadingItem[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: ReadingItem[] = [];
  let inSection = false;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (h[1]!.length <= 2) inSection = h[1]!.length === 2 && h[2]!.toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (!item) continue;
    const text = item[1]!;
    const md = /\[([^\]]*)\]\((\S+?)\)/.exec(text);
    const bare = md ? null : /<?(https?:\/\/[^\s<>)\]]+)>?/.exec(text);
    const url = md ? cleanUrl(md[2]!) : bare ? cleanUrl(bare[1]!) : null;
    if (!url || out.some((i) => i.url === url)) continue;
    const linkText = md ? md[1]!.replace(/[*_`]/g, '').trim() : '';
    const why = text.replace(md ? md[0] : bare![0], ' ').replace(/\s+/g, ' ').replace(/^[\s—–:|-]+|[\s—–:|-]+$/g, '').slice(0, MAX_WHY);
    out.push({ url, title: linkText && linkText !== url ? linkText : null, why });
    if (out.length === MAX_PAPERS_PER_DAY) break;
  }
  return out;
}

/** The URL the model reads: arXiv `abs` pages become the PDF (ADR-0029); anything else is read as given. */
export function readableUrl(url: string): string {
  const m = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/abs\/([A-Za-z0-9.\-/]+?)(?:[?#].*)?$/.exec(url);
  return m ? `https://arxiv.org/pdf/${m[1]}` : url;
}

/** ASCII, lowercase, hyphen-separated, ≤ 80 characters, never empty. */
export function slugify(text: string): string {
  const ascii = text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[øØ]/g, 'o');
  const slug = ascii.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, 80).replace(/-+$/, '');
  return cut || 'paper';
}

/** Slug of an item: its link text, else the URL (host + path), so it is known before any model call. */
export function itemSlug(item: ReadingItem): string {
  if (item.title) return slugify(item.title);
  const u = new URL(item.url);
  return slugify(`${u.hostname.replace(/^www\./, '')} ${u.pathname}`);
}

export const notePathFor = (date: string, slug: string): string => `${EXPLAINED_DIR}/${date} - ${slug}.md`;
const slugOfNoteName = (name: string): string | null => /^\d{4}-\d{2}-\d{2} - (.+)\.md$/.exec(name)?.[1] ?? null;

// ---- model output ----

const text = (max: number) => z.string().trim().min(1).max(max);
export const ExplanationJson = z.object({
  title: text(300),
  authors: z.array(text(120)).max(30).default([]),
  venue: text(200).nullable().default(null),
  plainWords: text(1500),
  keyIdeas: z.array(z.object({ idea: text(300), example: text(600) })).min(3).max(5),
  whyItMatters: text(1200),
  glossary: z.array(z.object({ term: text(80), meaning: text(400) })).max(12),
  tryIt: z.array(z.object({ experiment: text(500), minutes: z.number().int().min(1).max(480) })).min(1).max(3),
  howSolid: z.object({ limits: z.array(text(400)).min(1).max(5), evidence: text(800) }),
});
export type ExplanationJson = z.infer<typeof ExplanationJson>;

/** The same shape as a JSON Schema for the model's structured output (subset every Gemini JSON mode accepts). */
export const EXPLANATION_RESPONSE_SCHEMA = (() => {
  const s = { type: 'string' };
  const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties) });
  const arr = (items: unknown, minItems: number, maxItems: number) => ({ type: 'array', items, minItems, maxItems });
  return obj({
    title: s,
    authors: arr(s, 0, 30),
    venue: { type: ['string', 'null'] },
    plainWords: s,
    keyIdeas: arr(obj({ idea: s, example: s }), 3, 5),
    whyItMatters: s,
    glossary: arr(obj({ term: s, meaning: s }), 0, 12),
    tryIt: arr(obj({ experiment: s, minutes: { type: 'integer' } }), 1, 3),
    howSolid: obj({ limits: arr(s, 1, 5), evidence: s }),
  });
})();

export function explanationPrompt(item: ReadingItem, url: string): string {
  return [
    `Read the research paper at this URL: ${url}`,
    'Explain it in plain language for a curious reader who is not a specialist. Use only what the paper says.',
    `A research scout picked it for this reason: "${item.why || 'no reason given'}"`,
    'Reply with JSON only, with these fields:',
    '- title: the paper title; authors: author names; venue: where it was published, or null;',
    '- plainWords: at most 5 short sentences, no jargon;',
    '- keyIdeas: 3 to 5 items, each an idea with a small concrete example;',
    "- whyItMatters: why it may matter to the reader, based on the scout's reason and the paper;",
    '- glossary: the technical terms you had to use, each with a one-line meaning;',
    '- tryIt: 1 to 3 small experiments the reader could try, each with an estimate in minutes;',
    '- howSolid: limits (what the paper does not show) and evidence (how strong the support is).',
    'If you cannot open or read the paper, reply {"error":"unreadable"}.',
  ].join('\n');
}

// ---- rendering (exact golden test in research-explainer.test.ts) ----

export interface RenderMeta {
  readonly date: string;
  readonly source: string;
  /** Note name (without `.md`) the item came from, for the wikilink. */
  readonly scoutNote: string;
  readonly model: string;
}

/**
 * One line of model text made inert: control/bidi characters dropped, whitespace collapsed (no line may start a block),
 * HTML angle brackets escaped, a leading block marker backslash-escaped.
 */
export function inline(value: string): string {
  let s = '';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    s += control ? ' ' : ch;
  }
  s = s.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return /^([#>+\-*=|`~:%]|\d+[.)]|\[\^)/.test(s) ? `\\${s}` : s;
}

const linkText = (s: string): string => inline(s).replace(/[[\]]/g, (b) => `\\${b}`);
const linkUrl = (url: string): string => url.replace(/[()]/g, (p) => encodeURIComponent(p));
const yamlString = (s: string): string => JSON.stringify(s);

export function renderExplanation(json: ExplanationJson, meta: RenderMeta): string {
  const lines: string[] = [
    '---',
    'type: research-explained',
    `created: ${meta.date}`,
    `source: ${yamlString(meta.source)}`,
    `scout_note: ${yamlString(`[[${meta.scoutNote}]]`)}`,
    `model: ${meta.model}`,
    'status: complete',
    '---',
    '',
    `# ${inline(json.title)}`,
    '',
    '## In plain words',
    '',
    inline(json.plainWords),
    '',
    '## Key ideas',
    '',
    ...json.keyIdeas.map((k) => `- **${inline(k.idea)}** Example: ${inline(k.example)}`),
    '',
    '## Why it may matter to you',
    '',
    inline(json.whyItMatters),
    '',
    '## Glossary',
    '',
    ...(json.glossary.length > 0 ? json.glossary.map((g) => `- **${inline(g.term)}**: ${inline(g.meaning)}`) : ['- (none)']),
    '',
    '## Try it',
    '',
    ...json.tryIt.map((t) => `- ${inline(t.experiment)} (about ${t.minutes} min)`),
    '',
    '## How solid is it',
    '',
    ...json.howSolid.limits.map((l) => `- Limit: ${inline(l)}`),
    `- Evidence: ${inline(json.howSolid.evidence)}`,
    '',
    '## Source',
    '',
    `- [${linkText(json.title)}](${linkUrl(meta.source)})`,
  ];
  if (json.authors.length > 0) lines.push(`- Authors: ${json.authors.map(inline).join(', ')}`);
  if (json.venue) lines.push(`- Venue: ${inline(json.venue)}`);
  return `${lines.join('\n')}\n`;
}

// ---- deterministic operation IDs ----

/** A fixed namespace for this app's name-based UUIDs (random, generated once). */
const OP_NAMESPACE = '5b0c1d3e-8f2a-4c6b-9e1d-7a3f2b4c5d6e';

/** RFC 9562 UUIDv5 (SHA-1, name-based): same name ⇒ same ID. */
export async function uuidV5(name: string, namespace = OP_NAMESPACE): Promise<string> {
  const ns = Uint8Array.from(namespace.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
  const nameBytes = new TextEncoder().encode(name);
  const buf = new Uint8Array(ns.length + nameBytes.length);
  buf.set(ns);
  buf.set(nameBytes, ns.length);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', buf)).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `research-explainer:<date>`; the catch-up run adds `:catchup` (ADR-0029). */
export const explainerOperationId = (date: string, slot: ExplainerSlot): Promise<string> =>
  uuidV5(`research-explainer:${date}${slot === 'catchup' ? ':catchup' : ''}`);

// ---- the model port and chain ----

export type ModelOutcome =
  | { readonly kind: 'ok'; readonly text: string }
  /** 503 or 429: retried once on the same model. */
  | { readonly kind: 'unavailable' }
  /** Quota exhausted: next model at once. */
  | { readonly kind: 'quota' }
  /** The model could not open the URL (URL-context retrieval failed): the paper is skipped today. */
  | { readonly kind: 'url-unreadable' }
  /** Anything else (timeout, 4xx, malformed response): next model. */
  | { readonly kind: 'error' };

export interface PaperExplainer {
  explain(req: { readonly model: string; readonly url: string; readonly prompt: string }): Promise<ModelOutcome>;
}


export type FailureReason = 'models-unavailable' | 'invalid-json' | 'url-unreadable' | 'path-refused';

type ChainResult =
  | { readonly ok: true; readonly json: ExplanationJson; readonly model: string }
  | { readonly ok: false; readonly reason: FailureReason }
  /** The budget ran out mid-chain: the paper is deferred, not failed. */
  | { readonly ok: false; readonly reason: 'budget' };

interface ModelStats {
  errors: number;
  successes: number;
}

async function explainWithChain(
  explainer: PaperExplainer, item: ReadingItem, canCall: () => boolean, stats: ModelStats,
): Promise<ChainResult> {
  const url = readableUrl(item.url);
  const prompt = explanationPrompt(item, url);
  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!canCall()) return { ok: false, reason: 'budget' };
      const outcome = await explainer.explain({ model, url, prompt });
      if (outcome.kind === 'ok') {
        stats.successes++;
        return parseExplanation(outcome.text, model);
      }
      if (outcome.kind === 'url-unreadable') {
        stats.successes++;
        return { ok: false, reason: 'url-unreadable' };
      }
      stats.errors++;
      if (outcome.kind !== 'unavailable') break; // quota or error: next model, no retry
    }
  }
  return { ok: false, reason: 'models-unavailable' };
}

function parseExplanation(raw: string, model: string): ChainResult {
  const body = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const parsed = ExplanationJson.safeParse(value);
  return parsed.success ? { ok: true, json: parsed.data, model } : { ok: false, reason: 'invalid-json' };
}

// ---- the run ----

/** ADR-0029 amendment 2: a picked paper is retried on the day it was first seen and the next two; then it is given up. */
export const PENDING_DAYS = 3;
/**
 * Model calls stop after this much wall time, so the run (plus its commit) ends inside the 15-minute limit of a Cron
 * Trigger even when every call runs into its 60 s timeout.
 */
export const MODEL_TIME_BUDGET_MS = 10 * 60_000;

export type PendingPaper = NonNullable<ScoutStatus['pending']>[number];
type RetryReason = PendingPaper['lastReason'];

export interface ResearchExplainerDeps {
  readonly store: VaultStore;
  readonly explainer: PaperExplainer;
  readonly now: () => Date;
  readonly timeZone: string;
  /** Subrequests (GitHub + model) this invocation has made so far; the Worker counts its `fetch`. */
  readonly subrequests: () => number;
  readonly budget?: number;
  /** Wall time of this run so far (default: measured with `Date.now`). */
  readonly elapsedMs?: () => number;
}

export type ExplainerRunResult =
  | { readonly kind: 'no-input' }
  | { readonly kind: 'already-ran' }
  | {
    readonly kind: 'committed';
    readonly commitSha: string;
    readonly operationId: string;
    readonly written: number;
    readonly failed: number;
    readonly deferred: number;
  }
  | { readonly kind: 'not-written'; readonly reason: 'head-moved' | 'precondition-failed' | 'unknown-outcome' | 'budget' };

interface Input {
  readonly items: readonly ReadingItem[];
  readonly scoutNote: string;
}

async function readText(store: VaultStore, path: string, at: string): Promise<string | null> {
  const vp = parseVaultPath(path);
  const file = vp ? await store.readFile(vp, at) : null;
  return file ? new TextDecoder().decode(file.bytes) : null;
}

/** ADR-0029: today's brief `## Read today`; if that is empty, today's scout note `## Most relevant items`. */
async function readInput(store: VaultStore, at: string, date: string): Promise<Input | null> {
  const brief = await readText(store, briefPath(date), at);
  if (brief === null) return null;
  const items = parseReadingItems(brief, 'Read today');
  if (items.length > 0) return { items, scoutNote: `Research Reading Brief - ${date}` };
  const scout = await readText(store, scoutNotePath(date), at);
  const fallback = scout === null ? [] : parseReadingItems(scout, 'Most relevant items');
  return fallback.length > 0 ? { items: fallback, scoutNote: `Daily Research Scout - ${date}` } : null;
}

interface StatusAt {
  readonly exists: boolean;
  readonly prev: ScoutStatus | null;
}

async function readStatus(store: VaultStore, at: string): Promise<StatusAt> {
  const file = await store.readFile(EXPLAINER_STATUS_PATH as VaultPath, at);
  if (!file) return { exists: false, prev: null };
  try {
    const parsed = ScoutStatus.safeParse(JSON.parse(new TextDecoder().decode(file.bytes)));
    return { exists: true, prev: parsed.success ? parsed.data : null };
  } catch {
    return { exists: true, prev: null };
  }
}

/** Every note in `Research/Explained/` at a commit: path → blob SHA (one listing). */
async function listExplained(store: VaultStore, at: string): Promise<ReadonlyMap<string, string>> {
  return new Map((await store.listFiles(EXPLAINED_DIR, at)).map((f) => [f.path, f.blobSha]));
}

/** Dedupe (ADR-0029 amendment): the status record is committed with the notes, so it says whether this run landed. */
const alreadyRan = (prev: ScoutStatus | null, operationId: string): boolean =>
  prev?.history.some((h) => h.operationId === operationId) ?? false;

const REASON_TEXT: Record<FailureReason | 'budget', string> = {
  'models-unavailable': 'all models failed',
  'invalid-json': 'invalid model output',
  'url-unreadable': 'paper could not be read',
  'path-refused': 'note path refused',
  budget: 'not reached within the run limits',
};

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export interface PlaceholderMeta {
  /** The day the paper was first picked (the note's `created` and file-name date). */
  readonly date: string;
  readonly source: string;
  readonly scoutNote: string;
  readonly title: string | null;
  readonly why: string;
}

/**
 * ADR-0029 amendment 2: the note a picked paper gets while it has no explanation (`pending`), or after its last retry
 * failed (`unavailable`). Only the paper link and the scout's own why line: no model text.
 */
export function renderPlaceholder(
  meta: PlaceholderMeta, state: { readonly kind: 'pending' } | { readonly kind: 'unavailable'; readonly reason: RetryReason },
): string {
  const heading = meta.title ?? meta.source;
  const lines = [
    '---',
    'type: research-explained',
    `created: ${meta.date}`,
    `source: ${yamlString(meta.source)}`,
    `scout_note: ${yamlString(`[[${meta.scoutNote}]]`)}`,
    'model: ""',
    `status: ${state.kind}`,
    '---',
    '',
    `# ${inline(heading)}`,
    '',
    state.kind === 'pending'
      ? 'Explanation pending; retried automatically.'
      : `No explanation: ${REASON_TEXT[state.reason]} (tried for ${PENDING_DAYS} days).`,
    '',
    '## Source',
    '',
    `- [${linkText(heading)}](${linkUrl(meta.source)})`,
  ];
  if (meta.why) lines.push(`- Why the scout picked it: ${inline(meta.why)}`);
  return `${lines.join('\n')}\n`;
}

export interface RunFacts {
  readonly nowIso: string;
  readonly operationId: string;
  readonly configured: number;
  readonly written: readonly string[];
  readonly failures: readonly FailureReason[];
  readonly deferred: readonly string[];
  /** Papers given up after `PENDING_DAYS` (their note now says `unavailable`). */
  readonly gaveUp: number;
  readonly pending: readonly PendingPaper[];
  readonly stats: ModelStats;
}

/** The ScoutStatus record (ADR-0020 schema): counts and fixed phrases, plus the retry list (links and scout lines). */
export function buildExplainerStatus(prev: ScoutStatus | null, f: RunFacts): ScoutStatus {
  const clean = f.failures.length === 0 && f.deferred.length === 0 && f.gaveUp === 0;
  const runStatus: ScoutStatus['runStatus'] & string = clean ? 'success' : 'degraded';
  const calls = f.stats.successes + f.stats.errors;
  const aiHealth = calls === 0 ? (prev?.aiHealth ?? null) : f.stats.successes === 0 ? 'failed' : f.stats.errors > 0 ? 'degraded' : 'healthy';
  const problems = [
    ...(f.failures.length > 0 ? [`${f.failures.length} of ${f.configured} papers not explained (${[...new Set(f.failures)].map((r) => REASON_TEXT[r]).join(', ')})`] : []),
    ...(f.deferred.length > 0 ? [`${f.deferred.length} deferred to the next run (run limits)`] : []),
    ...(f.gaveUp > 0 ? [`${f.gaveUp} given up after ${PENDING_DAYS} days`] : []),
  ];
  return {
    schemaVersion: 1,
    scoutId: EXPLAINER_SCOUT_ID,
    displayName: 'Research explainer',
    schedule: 'daily 04:30 UTC, catch-up 06:30 UTC',
    expectedEveryHours: 24,
    lastAttemptAt: f.nowIso,
    lastSuccessAt: runStatus === 'success' ? f.nowIso : (prev?.lastSuccessAt ?? null),
    runStatus,
    sources: { configured: f.configured, successful: f.configured - f.failures.length - f.deferred.length },
    aiHealth,
    findings: f.written.length,
    added: f.written.length,
    errors: f.failures.length,
    lastError: problems.length === 0 ? null : problems.join('; ').slice(0, 200),
    latestOutput: f.written.at(-1) ?? prev?.latestOutput ?? null,
    history: [...(prev?.history ?? []), { at: f.nowIso, status: runStatus, findings: f.written.length, operationId: f.operationId }].slice(-30),
    ...(f.pending.length > 0 ? { pending: [...f.pending] } : {}),
  };
}

/** Items whose slug is not already a note (any date) at a commit; one per slug. */
function notYetExplained<T extends { readonly slug: string }>(items: readonly T[], existingPaths: Iterable<string>): T[] {
  const seen = new Set([...existingPaths].map((p) => slugOfNoteName(p.slice(p.lastIndexOf('/') + 1))).filter((s) => s !== null));
  return items.filter((i) => (seen.has(i.slug) ? false : (seen.add(i.slug), true)));
}

type Candidate =
  | { readonly kind: 'new'; readonly item: ReadingItem; readonly scoutNote: string; readonly path: VaultPath | null }
  | { readonly kind: 'retry'; readonly item: ReadingItem; readonly scoutNote: string; readonly path: VaultPath; readonly pending: PendingPaper };

interface PlannedWrite {
  readonly path: VaultPath;
  /** Blob SHA the path must still have at the commit's base (null: absent). */
  readonly oldSha: string | null;
  readonly bytes: Uint8Array;
  /** A full explanation (counts as a finding). */
  readonly complete: boolean;
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

export async function runResearchExplainer(deps: ResearchExplainerDeps, slot: ExplainerSlot): Promise<ExplainerRunResult> {
  const { store } = deps;
  const budget = deps.budget ?? SUBREQUEST_BUDGET;
  const t0 = Date.now();
  const elapsed = deps.elapsedMs ?? (() => Date.now() - t0);
  const now = deps.now();
  const date = userDate(now, deps.timeZone);
  const operationId = await explainerOperationId(date, slot);

  const x0 = (await store.head()).commitSha;
  const status0 = await readStatus(store, x0);
  if (alreadyRan(status0.prev, operationId)) return { kind: 'already-ran' };
  const pending0 = status0.prev?.pending ?? [];
  const input = await readInput(store, x0, date);
  if (!input && pending0.length === 0) return { kind: 'no-input' };
  const listed0 = await listExplained(store, x0);

  // Carry-over first, oldest first (ADR-0029 amendment 2). A pending note that no longer has the content this job wrote
  // (the owner edited or removed it) is left alone and dropped from the list.
  const writes: PlannedWrite[] = [];
  const retries: Candidate[] = [];
  let gaveUp = 0;
  for (const p of [...pending0].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen))) {
    const path = parseVaultPath(p.path);
    if (!path || !isExplainedNotePath(path) || listed0.get(path) !== p.blobSha) continue;
    if (daysBetween(p.firstSeen, date) >= PENDING_DAYS) {
      const meta = { date: p.firstSeen, source: p.url, scoutNote: p.scoutNote, title: p.title, why: p.why };
      writes.push({ path, oldSha: p.blobSha, bytes: encode(renderPlaceholder(meta, { kind: 'unavailable', reason: p.lastReason })), complete: false });
      gaveUp++;
      continue;
    }
    retries.push({ kind: 'retry', item: { url: p.url, title: p.title, why: p.why }, scoutNote: p.scoutNote, path, pending: p });
  }
  const pendingUrls = new Set(pending0.map((p) => p.url));
  const fresh = input
    ? notYetExplained(input.items.filter((i) => !pendingUrls.has(i.url)).map((item) => ({ item, slug: itemSlug(item) })), listed0.keys())
    : [];
  const candidates: Candidate[] = [
    ...retries,
    ...fresh.map(({ item, slug }): Candidate => ({ kind: 'new', item, scoutNote: input!.scoutNote, path: parseVaultPath(notePathFor(date, slug)) })),
  ];

  const stats: ModelStats = { errors: 0, successes: 0 };
  const failures: FailureReason[] = [];
  const deferred: string[] = [];
  const nextPending: PendingPaper[] = [];
  let attempted = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (!c.path || !canWrite(c.path, c.kind === 'new' ? 'create' : 'update')) {
      failures.push('path-refused');
      continue;
    }
    // Files the commit must hold whatever happens next: those planned, one per remaining new paper (explained or
    // pending), this retry's replacement, and the status record. A model call is made only if they stay paid for.
    const reserve = writes.length + candidates.slice(i).filter((k) => k.kind === 'new').length + (c.kind === 'retry' ? 1 : 0) + 1;
    const canCall = () => elapsed() < MODEL_TIME_BUDGET_MS && deps.subrequests() + 1 + commitCost(reserve) <= budget;
    const outOfRun = attempted >= MAX_PAPERS_PER_DAY || deferred.length > 0;
    if (!outOfRun) attempted++;
    const result: ChainResult = outOfRun ? { ok: false, reason: 'budget' } : await explainWithChain(deps.explainer, c.item, canCall, stats);
    if (result.ok) {
      const created = c.kind === 'retry' ? c.pending.firstSeen : date;
      const markdown = renderExplanation(result.json, { date: created, source: c.item.url, scoutNote: c.scoutNote, model: result.model });
      writes.push({ path: c.path, oldSha: c.kind === 'retry' ? c.pending.blobSha : null, bytes: encode(markdown), complete: true });
      continue;
    }
    const reason = result.reason as RetryReason;
    if (reason === 'budget') deferred.push(c.item.url);
    else failures.push(reason);
    if (c.kind === 'retry') {
      nextPending.push({ ...c.pending, lastReason: reason });
      continue;
    }
    // Every picked paper gets its note at once: a pending one, replaced when a later run explains it.
    const bytes = encode(renderPlaceholder({ date, source: c.item.url, scoutNote: c.scoutNote, title: c.item.title, why: c.item.why }, { kind: 'pending' }));
    writes.push({ path: c.path, oldSha: null, bytes, complete: false });
    nextPending.push({
      url: c.item.url, title: c.item.title, why: c.item.why, scoutNote: c.scoutNote, firstSeen: date, path: c.path,
      blobSha: await gitBlobSha(bytes), lastReason: reason,
    });
  }

  const statusPath = parseVaultPath(EXPLAINER_STATUS_PATH)!;
  let status = status0;
  let listed = listed0;
  let unknown = false;
  for (let attempt = 1; attempt <= EXPLAINER_WRITE_ATTEMPTS; attempt++) {
    let x = x0;
    if (attempt > 1) {
      if (deps.subrequests() + REPLAN_COST + commitCost(writes.length + 1) > budget) return { kind: 'not-written', reason: 'budget' };
      // Re-plan at the new head without new model calls: our own lost commit, or a concurrent run, shows in the status.
      x = (await store.head()).commitSha;
      status = await readStatus(store, x);
      if (alreadyRan(status.prev, operationId)) return { kind: 'already-ran' };
      listed = await listExplained(store, x);
    }
    // CAS on blob SHA at the pinned base (rule 4): a note that appeared or changed since planning is left alone.
    const due = writes.filter((w) => (listed.get(w.path) ?? null) === w.oldSha);
    const duePaths = new Set<string>(due.map((w) => w.path));
    const pending = nextPending.filter((p) => duePaths.has(p.path) || listed.get(p.path) === p.blobSha);
    const written = due.filter((w) => w.complete).map((w) => w.path);
    const record = buildExplainerStatus(status.prev, {
      nowIso: now.toISOString(), operationId, configured: candidates.length, written, failures, deferred, gaveUp, pending, stats,
    });
    const files = [
      ...due.map((w) => ({ path: w.path, expect: w.oldSha === null ? 'absent' as const : 'regular-file' as const, bytes: w.bytes })),
      { path: statusPath, expect: status.exists ? 'regular-file' as const : 'absent' as const, bytes: encode(`${JSON.stringify(record, null, 2)}\n`) },
    ];
    // Every path passes the write allowlist before any blob is sent (ADR-0029 amendment).
    if (!files.every((f) => canWrite(f.path, f.expect === 'absent' ? 'create' : 'update'))) return { kind: 'not-written', reason: 'precondition-failed' };
    try {
      const res = await store.writeFiles({
        baseCommit: x,
        files,
        message: 'Vault Companion: research explainer',
        trailers: { [TRAILER_JOB]: EXPLAINER_SCOUT_ID, [TRAILER_OP]: operationId },
      });
      if (res.ok) {
        return { kind: 'committed', commitSha: res.commitSha, operationId, written: written.length, failed: failures.length, deferred: deferred.length };
      }
      if (res.reason === 'precondition-failed') return { kind: 'not-written', reason: 'precondition-failed' };
      unknown = false;
    } catch (err) {
      if (!(err instanceof StoreUnknownOutcome)) throw err;
      unknown = true; // the next attempt's status read decides whether it landed
    }
  }
  return { kind: 'not-written', reason: unknown ? 'unknown-outcome' : 'head-moved' };
}
