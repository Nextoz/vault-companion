// SIWH: "Since I was here" - the short closable pane at the top of Today listing data added since the owner last
// looked. Everything here is a pure projection of reads the Today card already holds; nothing is fetched, nothing is
// written to the vault, and a source that is unavailable yields no line (never a fake zero).
//
// A line appears only when a source the device HAS observed moved up: a higher count, a newer date, or a new key.
// A decrease (the owner handled items), an unchanged source, and a source seen for the first time are all silent. The
// first visit has no snapshot at all: it shows nothing and just records the baseline.
import type { HealthResponse, MorningBriefResponse, MorningResponse, ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';
import { pluralise } from '../scouts.ts';

/** The one place a line opens: the Scouts tab (triage and scouts), the morning panel (brief and papers), or Health. */
export type SiwhTarget = 'triage' | 'scouts' | 'papers' | 'health';

export interface SiwhLine {
  readonly id: string;
  readonly text: string;
  readonly target: SiwhTarget;
}

/** A scout's newest successful run and how many findings it produced. */
export interface SiwhScout {
  readonly id: string;
  readonly name: string;
  readonly findings: number;
}

/** Counts and keys from the Today card's own reads; `null` means that read is unavailable, so it yields no line. */
export interface SiwhFacts {
  /** Event ids waiting in triage, or null when the read is unavailable. Ids, not a count, so handling a card never
   *  masks a later arrival that lands on the same count. */
  readonly triage: readonly string[] | null;
  readonly scouts: readonly SiwhScout[] | null;
  /** The date of a usable (today's) Morning Brief, or null when there is none. */
  readonly brief: string | null;
  /** Paths of the explained research papers, or null when the read is unavailable. */
  readonly papers: readonly string[] | null;
  /** The latest health day, or null when there is no usable health read. */
  readonly health: string | null;
}

/** Device-held last-seen state. An absent field means that source was never observed on this device. */
export interface SiwhSnapshot {
  readonly at: number;
  readonly triage?: readonly string[];
  readonly scouts?: Readonly<Record<string, number>>;
  readonly brief?: string;
  readonly papers?: readonly string[];
  readonly health?: string;
}

/** The pane never renders more than this many lines, however many sources moved. */
export const SIWH_MAX_LINES = 5;

/** The findings of a scout's newest successful run (history is ascending), or null when it never succeeded. */
export function latestSuccessfulFindings(status: ScoutStatus): number | null {
  for (let index = status.history.length - 1; index >= 0; index -= 1) {
    const run = status.history[index]!;
    if (run.status === 'success' && run.findings !== null) return run.findings;
  }
  return status.runStatus === 'success' ? status.findings : null;
}

/** One entry per readable scout that has a successful-run findings count; an unreadable or never-succeeded scout is skipped. */
export function scoutFindings(response: ScoutsResponse): SiwhScout[] {
  const scouts: SiwhScout[] = [];
  for (const entry of response.scouts) {
    if (entry.state !== 'ok') continue;
    const findings = latestSuccessfulFindings(entry.status);
    if (findings === null) continue;
    scouts.push({ id: entry.status.scoutId, name: entry.status.displayName, findings });
  }
  return scouts;
}

/** The reads the Today card holds, narrowed to the counts/keys the pane compares. Pure. */
export interface SiwhFactInput {
  /** Event ids waiting in triage (cards plus check-ins), or null when the read is unavailable. */
  readonly triage: readonly string[] | null;
  readonly scouts: ScoutsResponse | null;
  readonly brief: MorningBriefResponse | null;
  readonly morning: MorningResponse | null;
  readonly health: HealthResponse | null;
  /** Today in Europe/Copenhagen; a brief from another day is not "this morning". */
  readonly today: string;
}

export function sinceIWasHereFacts(input: SiwhFactInput): SiwhFacts {
  return {
    triage: input.triage,
    scouts: input.scouts === null ? null : scoutFindings(input.scouts),
    brief: input.brief !== null && input.brief.date === input.today ? input.brief.date : null,
    papers: input.morning === null ? null : input.morning.explained
      .filter((note) => note.status === 'ok')
      .map((note) => note.path),
    health: input.health !== null && input.health.status === 'ok' ? input.health.day ?? null : null,
  };
}

/**
 * The pane's lines: a source is announced only when the device had observed it before and it moved up. A null snapshot
 * (first install) is silent. At most `max` lines are returned. Pure and total.
 */
export function sinceIWasHereLines(facts: SiwhFacts, snapshot: SiwhSnapshot | null, max = SIWH_MAX_LINES): SiwhLine[] {
  if (snapshot === null) return [];
  const lines: SiwhLine[] = [];

  if (facts.triage !== null && snapshot.triage !== undefined) {
    const seen = new Set(snapshot.triage);
    const added = facts.triage.filter((eventId) => !seen.has(eventId)).length;
    if (added > 0) lines.push({ id: 'triage', text: `${pluralise(added, 'event')} in triage`, target: 'triage' });
  }

  if (facts.scouts !== null && snapshot.scouts !== undefined) {
    for (const scout of facts.scouts) {
      const seen = snapshot.scouts[scout.id];
      if (seen === undefined || scout.findings <= seen) continue;
      lines.push({ id: `scout:${scout.id}`, text: `${scout.name} \u00b7 ${pluralise(scout.findings - seen, 'new finding')}`, target: 'scouts' });
    }
  }

  if (facts.brief !== null && snapshot.brief !== undefined && facts.brief !== snapshot.brief) {
    lines.push({ id: 'brief', text: 'New morning brief', target: 'papers' });
  }

  if (facts.papers !== null && snapshot.papers !== undefined) {
    const seen = new Set(snapshot.papers);
    const added = facts.papers.filter((path) => !seen.has(path)).length;
    if (added > 0) lines.push({ id: 'papers', text: pluralise(added, 'new explained paper'), target: 'papers' });
  }

  if (facts.health !== null && snapshot.health !== undefined && facts.health > snapshot.health) {
    lines.push({ id: 'health', text: 'New health day', target: 'health' });
  }

  return lines.slice(0, max);
}

const findingsMap = (scouts: readonly SiwhScout[]): Record<string, number> => {
  const map: Record<string, number> = {};
  for (const scout of scouts) map[scout.id] = scout.findings;
  return map;
};

/** What the pane stores when the owner closes or dismisses it: every source's current value, keeping a previous value
 *  for a source that is unavailable right now (so a transient failure never resets what was already seen). Pure. */
export function snapshotOf(facts: SiwhFacts, previous: SiwhSnapshot | null, at: number): SiwhSnapshot {
  const next: MutableSnapshot = { at };
  if (facts.triage !== null) next.triage = [...facts.triage];
  else if (previous?.triage !== undefined) next.triage = [...previous.triage];
  if (facts.scouts !== null) next.scouts = findingsMap(facts.scouts);
  else if (previous?.scouts !== undefined) next.scouts = { ...previous.scouts };
  if (facts.brief !== null) next.brief = facts.brief;
  else if (previous?.brief !== undefined) next.brief = previous.brief;
  if (facts.papers !== null) next.papers = [...facts.papers];
  else if (previous?.papers !== undefined) next.papers = [...previous.papers];
  if (facts.health !== null) next.health = facts.health;
  else if (previous?.health !== undefined) next.health = previous.health;
  return next;
}

/**
 * First install and late-loading sources: record a value the device has never seen, without announcing it. A source
 * already in the snapshot is left exactly as it is, so a render never advances what the owner has already seen. Pure.
 */
export function establishBaseline(stored: SiwhSnapshot | null, facts: SiwhFacts, at: number): SiwhSnapshot {
  const next: MutableSnapshot = { at: stored?.at ?? at };
  if (stored?.triage !== undefined) next.triage = [...stored.triage];
  else if (facts.triage !== null) next.triage = [...facts.triage];
  if (stored?.scouts !== undefined) next.scouts = { ...stored.scouts };
  else if (facts.scouts !== null) next.scouts = findingsMap(facts.scouts);
  if (stored?.brief !== undefined) next.brief = stored.brief;
  else if (facts.brief !== null) next.brief = facts.brief;
  if (stored?.papers !== undefined) next.papers = [...stored.papers];
  else if (facts.papers !== null) next.papers = [...facts.papers];
  if (stored?.health !== undefined) next.health = stored.health;
  else if (facts.health !== null) next.health = facts.health;
  return next;
}

interface MutableSnapshot {
  at: number;
  triage?: string[];
  scouts?: Record<string, number>;
  brief?: string;
  papers?: string[];
  health?: string;
}

const sameRecord = (a: Readonly<Record<string, number>> | undefined, b: Readonly<Record<string, number>> | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

/** Order-independent equality, so a baseline is only written to prefs when it actually changed. */
export function sameSnapshot(a: SiwhSnapshot | null, b: SiwhSnapshot): boolean {
  if (a === null) return false;
  return a.at === b.at && sameList(a.triage, b.triage) && a.brief === b.brief && a.health === b.health
    && sameRecord(a.scouts, b.scouts) && sameList(a.papers, b.papers);
}

/**
 * Reads the device-held snapshot from localStorage text. A malformed or unrecognised value reads as null, so a bad
 * entry can never crash the pane or make it announce a guess. Pure.
 */
export function parseSinceIWasHereSnapshot(raw: string | null): SiwhSnapshot | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const at = record['at'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const snapshot: MutableSnapshot = { at };
  const triage = record['triage'];
  if (triage !== undefined) {
    if (!Array.isArray(triage) || !triage.every((eventId): eventId is string => typeof eventId === 'string')) return null;
    snapshot.triage = [...triage];
  }
  const scouts = record['scouts'];
  if (scouts !== undefined) {
    if (scouts === null || typeof scouts !== 'object' || Array.isArray(scouts)) return null;
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(scouts)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      map[key] = value;
    }
    snapshot.scouts = map;
  }
  const brief = record['brief'];
  if (brief !== undefined) {
    if (typeof brief !== 'string') return null;
    snapshot.brief = brief;
  }
  const papers = record['papers'];
  if (papers !== undefined) {
    if (!Array.isArray(papers) || !papers.every((path): path is string => typeof path === 'string')) return null;
    snapshot.papers = [...papers];
  }
  const health = record['health'];
  if (health !== undefined) {
    if (typeof health !== 'string') return null;
    snapshot.health = health;
  }
  return snapshot;
}
