// MB3b: the PC Morning Digest note is the tracked source for the brief's News, AI-and-research and One-thing
// sections. This module is pure: it builds the note's vault path and parses the note tolerantly. Malformed bullets are
// skipped, non-https links dropped, every field capped, and it never throws or logs note text. Digest text is never
// sent to the model; the writer passes parsed fields through unchanged.
import { parseVaultPath } from './paths.ts';
import type { VaultPath } from './store.ts';

/** A digest bullet: a headline, its one-line summary, and the https link they came from. */
export interface DigestItem {
  readonly title: string;
  readonly line: string;
  readonly url: string;
}

/** The digest's closing thought: a paragraph and, when present, its pull quote. */
export interface DigestOneThing {
  readonly text: string;
  readonly quote?: string;
}

export interface DigestSections {
  readonly news: DigestItem[];
  readonly research: DigestItem[];
  readonly oneThing: DigestOneThing | null;
  /** True when the note carried at least one of the three expected `##` headings (otherwise it is not a digest). */
  readonly recognized: boolean;
}

/** At most this many bullets survive per section (owner MB3b cap). */
export const DIGEST_ITEM_MAX = 3;
export const DIGEST_TITLE_MAX = 200;
export const DIGEST_LINE_MAX = 300;
export const DIGEST_URL_MAX = 500;
export const DIGEST_TEXT_MAX = 500;

const DIGEST_DIR = 'Daily/Morning Digest';

/** `Daily/Morning Digest/Morning Digest - YYYY-MM-DD.md` for a valid date; `null` for anything else. */
export function morningDigestPath(date: string): VaultPath | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const midnight = `${date}T00:00:00.000Z`;
  if (!Number.isFinite(Date.parse(midnight)) || new Date(midnight).toISOString().slice(0, 10) !== date) return null;
  return parseVaultPath(`${DIGEST_DIR}/Morning Digest - ${date}.md`);
}

const empty = (): DigestSections => ({ news: [], research: [], oneThing: null, recognized: false });

/** `- **Title** - one line ([link](https://...))`; any other shape is skipped as malformed. */
const BULLET = /^-\s+\*\*(?<title>.+?)\*\*\s+-\s+(?<line>.*?)\s*\(\[[^\]]*\]\((?<url>https:\/\/[^)\s]+)\)\)\s*$/;
const HEADING = /^##\s+(?<name>.+?)\s*$/;

type Section = 'news' | 'research' | 'oneThing' | null;

function sectionOf(name: string): Section {
  const key = name.trim().toLowerCase();
  if (key === 'news') return 'news';
  if (key === 'ai and research') return 'research';
  if (key === 'one thing') return 'oneThing';
  return null;
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Parse the digest note's News, AI-and-research and One-thing sections. Tolerant and total: never throws. */
export function parseDigestNote(markdown: string): DigestSections {
  try {
    if (typeof markdown !== 'string' || markdown.length === 0) return empty();
    const news: DigestItem[] = [];
    const research: DigestItem[] = [];
    const oneLines: string[] = [];
    const quoteLines: string[] = [];
    let section: Section = null;
    let recognized = false;

    for (const raw of markdown.split(/\r?\n/)) {
      const heading = HEADING.exec(raw);
      if (heading) {
        section = sectionOf(heading.groups!.name!);
        if (section !== null) recognized = true;
        continue;
      }
      if (section === 'news' || section === 'research') {
        const target = section === 'news' ? news : research;
        if (target.length >= DIGEST_ITEM_MAX) continue;
        const match = BULLET.exec(raw);
        if (!match) continue;
        const title = cap(match.groups!.title!.trim(), DIGEST_TITLE_MAX);
        const line = cap(match.groups!.line!.trim(), DIGEST_LINE_MAX);
        const url = match.groups!.url!;
        if (title.length === 0 || url.length > DIGEST_URL_MAX) continue;
        target.push({ title, line, url });
      } else if (section === 'oneThing') {
        const text = raw.trim();
        if (text.startsWith('>')) quoteLines.push(text.replace(/^>\s?/, ''));
        else if (text.length > 0) oneLines.push(text);
      }
    }

    const text = cap(oneLines.join(' ').trim(), DIGEST_TEXT_MAX);
    const quote = cap(quoteLines.join(' ').trim(), DIGEST_TEXT_MAX);
    const oneThing = text.length === 0 && quote.length === 0 ? null
      : { text, ...(quote.length > 0 ? { quote } : {}) };
    return { news, research, oneThing, recognized };
  } catch {
    return empty();
  }
}
