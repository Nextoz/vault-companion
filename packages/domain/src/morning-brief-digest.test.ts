import { describe, expect, it } from 'vitest';
import {
  DIGEST_COPENHAGEN_MAX,
  DIGEST_ITEM_MAX,
  DIGEST_LINE_MAX,
  DIGEST_NEEDS_YOU_MAX,
  DIGEST_TITLE_MAX,
  morningDigestPath,
  parseDigestNote,
} from './morning-brief-digest.ts';

// All fixtures are synthetic: invented titles and links, never a real digest line.
const bullet = (title: string, line: string, url: string) => `- **${title}** - ${line} ([link](${url}))`;

const note = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

describe('morningDigestPath', () => {
  it('builds the tracked digest path for a valid date only', () => {
    expect(morningDigestPath('2026-06-15')).toBe('Daily/Morning Digest/Morning Digest - 2026-06-15.md');
    expect(morningDigestPath('2026-02-30')).toBeNull();
    expect(morningDigestPath('2026-6-15')).toBeNull();
  });
});

describe('parseDigestNote', () => {
  it('parses News and AI-and-research bullets into title, line and url', () => {
    const parsed = parseDigestNote(note([
      '## News',
      bullet('Synthetic Alpha', 'A synthetic first line.', 'https://example.test/a'),
      '',
      '## AI and research',
      bullet('Synthetic Beta', 'A synthetic finding.', 'https://example.test/b'),
    ]));
    expect(parsed.recognized).toBe(true);
    expect(parsed.news).toEqual([{ title: 'Synthetic Alpha', line: 'A synthetic first line.', url: 'https://example.test/a' }]);
    expect(parsed.research).toEqual([{ title: 'Synthetic Beta', line: 'A synthetic finding.', url: 'https://example.test/b' }]);
  });

  it('drops a bullet whose only link is not https', () => {
    const parsed = parseDigestNote(note([
      '## News',
      bullet('Synthetic Insecure', 'Insecure link.', 'http://example.test/x'),
      bullet('Synthetic Kept', 'Secure link.', 'https://example.test/y'),
    ]));
    expect(parsed.news.map((item) => item.title)).toEqual(['Synthetic Kept']);
  });

  it('skips malformed bullets instead of guessing', () => {
    const parsed = parseDigestNote(note([
      '## News',
      '- **No link at all** - missing',
      '- plain text, no bold',
      bullet('Synthetic Valid', 'Kept.', 'https://example.test/v'),
    ]));
    expect(parsed.news).toHaveLength(1);
    expect(parsed.news[0]!.title).toBe('Synthetic Valid');
  });

  it('caps the survivor count, the title and the summary length', () => {
    const parsed = parseDigestNote(note([
      '## News',
      ...Array.from({ length: 5 }, (_, i) => bullet(`T${i}`, 'short', `https://example.test/${i}`)),
      '## AI and research',
      bullet('T'.repeat(DIGEST_TITLE_MAX + 50), 'L'.repeat(DIGEST_LINE_MAX + 50), 'https://example.test/long'),
    ]));
    expect(parsed.news).toHaveLength(DIGEST_ITEM_MAX);
    expect(parsed.research[0]!.title).toHaveLength(DIGEST_TITLE_MAX);
    expect(parsed.research[0]!.line).toHaveLength(DIGEST_LINE_MAX);
  });

  it('parses One thing into a paragraph plus its quote', () => {
    const parsed = parseDigestNote(note([
      '## One thing',
      'A synthetic paragraph for the day.',
      '',
      '> A synthetic pull quote.',
    ]));
    expect(parsed.oneThing).toEqual({ text: 'A synthetic paragraph for the day.', quote: 'A synthetic pull quote.' });
  });

  it('parses Needs-you and Copenhagen-today bullets with their https links', () => {
    const parsed = parseDigestNote(note([
      '## Needs you',
      bullet('Synthetic Mail', 'A synthetic message.', 'https://mail.google.com/mail/u/0/#inbox/synthetic-id'),
      '',
      '## Copenhagen today',
      bullet('17:00 Synthetic Event', 'A synthetic plan.', 'https://www.google.com/calendar/event?eid=synthetic'),
    ]));
    expect(parsed.recognized).toBe(true);
    expect(parsed.needsYou).toEqual([{ title: 'Synthetic Mail', line: 'A synthetic message.', url: 'https://mail.google.com/mail/u/0/#inbox/synthetic-id' }]);
    expect(parsed.copenhagen).toEqual([{ title: '17:00 Synthetic Event', line: 'A synthetic plan.', url: 'https://www.google.com/calendar/event?eid=synthetic' }]);
  });

  it('drops non-https Needs-you and Copenhagen bullets and skips malformed ones', () => {
    const parsed = parseDigestNote(note([
      '## Needs you',
      bullet('Synthetic Insecure', 'Insecure link.', 'http://mail.google.com/inbox'),
      '- **No link at all** - missing',
      bullet('Synthetic Kept', 'Secure link.', 'https://mail.google.com/mail/u/0/#inbox/keep'),
      '## Copenhagen today',
      bullet('Synthetic Insecure', 'Insecure link.', 'http://www.google.com/calendar/event'),
      bullet('Synthetic Kept', 'Secure link.', 'https://www.google.com/calendar/event?eid=keep'),
    ]));
    expect(parsed.needsYou.map((item) => item.title)).toEqual(['Synthetic Kept']);
    expect(parsed.copenhagen.map((item) => item.title)).toEqual(['Synthetic Kept']);
  });

  it('caps Needs you at five and Copenhagen today at three', () => {
    const parsed = parseDigestNote(note([
      '## Needs you',
      ...Array.from({ length: 8 }, (_, i) => bullet(`N${i}`, 'short', `https://mail.google.com/mail/u/0/#inbox/${i}`)),
      '## Copenhagen today',
      ...Array.from({ length: 6 }, (_, i) => bullet(`C${i}`, 'short', `https://www.google.com/calendar/event?eid=${i}`)),
    ]));
    expect(parsed.needsYou).toHaveLength(DIGEST_NEEDS_YOU_MAX);
    expect(parsed.copenhagen).toHaveLength(DIGEST_COPENHAGEN_MAX);
  });

  it('never throws on garbage and reports an unrecognised note', () => {
    for (const input of ['', 'not a digest at all', '# Heading only', '\u0000 weird']) {
      expect(() => parseDigestNote(input)).not.toThrow();
      expect(parseDigestNote(input).recognized).toBe(false);
    }
    expect(parseDigestNote('a note with no sections').news).toEqual([]);
    expect(parseDigestNote(null as unknown as string)).toEqual({ news: [], research: [], needsYou: [], copenhagen: [], oneThing: null, recognized: false });
  });
});
