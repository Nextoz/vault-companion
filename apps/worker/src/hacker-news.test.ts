import { describe, expect, it } from 'vitest';
import { MorningBriefResponse, briefHackerNews } from '@vault-companion/contracts';
import { parseBriefFile, parseDigestNote, serializeBriefFile, type BriefFile } from '@vault-companion/domain';
import { renderBriefEmail } from './morning-brief-email.ts';

const url = 'https://news.ycombinator.com/item?id=123';
const bullet = (id: number, link = `${url}${id}`) => `- **Synthetic headline ${id}** - 100 points; 20 comments on Hacker News ([link](${link}))`;
const makeFile = (note: string): BriefFile => {
  const parsed = parseDigestNote(note);
  return {
    schemaVersion: 2, date: '2026-10-15', generatedAt: '2026-10-15T06:00:00Z', source: 'fallback',
    unavailable: [], unavailableReasons: {},
    brief: { source: 'fallback', meetings: [], dayLine: 'Synthetic day', gaps: [], todos: [],
      ...(parsed.hackerNews !== undefined ? { hackerNews: parsed.hackerNews, hackerNewsUnavailable: parsed.hackerNewsUnavailable ?? false } : {}),
    },
  };
};

describe('Hacker News digest contract', () => {
  it('keeps three ranked bullets through note, file, response, shared presentation and email', () => {
    const file = parseBriefFile(serializeBriefFile(makeFile(`## Hacker News\n${[1, 2, 3, 4].map((id) => bullet(id)).join('\n')}`)))!;
    const response = MorningBriefResponse.parse({ revision: 'a'.repeat(40), date: file.date, generatedAt: file.generatedAt,
      source: file.source, unavailable: file.unavailable, brief: file.brief });
    const shown = briefHackerNews(response)!;
    expect(shown.items.map((item) => item.title)).toEqual(['Synthetic headline 1', 'Synthetic headline 2', 'Synthetic headline 3']);
    expect(shown.message).toBeNull();
    const email = renderBriefEmail(file);
    for (const surface of [email.text, email.html]) {
      expect(surface).toContain('Hacker News');
      expect(surface).toContain(`${url}1`);
      expect(surface).not.toContain('Synthetic headline 4');
    }
  });

  it.each([
    ['## News', null],
    ['## Hacker News\nNothing new here today.', 'Nothing new here today.'],
    ['## Hacker News\nSource unavailable.', 'Source unavailable.'],
  ])('distinguishes legacy, empty and unavailable notes: %s', (note, expected) => {
    const file = parseBriefFile(serializeBriefFile(makeFile(note)))!;
    const shown = briefHackerNews(file);
    if (expected === null) expect(shown).toBeNull();
    else {
      expect(shown).toEqual({ items: [], message: expected });
      expect(renderBriefEmail(file).text).toContain(expected);
      expect(renderBriefEmail(file).html).toContain(expected);
    }
  });

  it('marks a missing digest honestly without inventing an empty feed', () => {
    const file = { ...makeFile(''), unavailable: ['digest'], unavailableReasons: { digest: 'not-found' as const } };
    expect(briefHackerNews(file)).toEqual({ items: [], message: 'Hacker News unavailable: the note was not found' });
  });

  it('drops unsafe or unrelated links before applying the three-item cap', () => {
    const note = `## Hacker News\n${[
      bullet(0, 'javascript:alert(1)'), bullet(0, 'https://example.test/item?id=1'),
      bullet(0, 'https://user@news.ycombinator.com/item?id=1'), bullet(0, 'https://news.ycombinator.com/item?id=bad'),
      bullet(1), bullet(2), bullet(3),
    ].join('\n')}`;
    expect(parseDigestNote(note).hackerNews).toHaveLength(3);
    expect(parseDigestNote(note).hackerNews?.[0]?.title).toBe('Synthetic headline 1');
  });

  it('decodes producer Markdown escaping for plain text display and escapes HTML in email', () => {
    const file = makeFile('## Hacker News\n- **Synthetic \\[title\\] \\*one\\* <b>** - 100 points; 20 comments on Hacker News ([link](' + url + '))');
    expect(file.brief.hackerNews?.[0]?.title).toBe('Synthetic [title] *one* <b>');
    expect(renderBriefEmail(file).html).not.toContain('<b>');
    expect(renderBriefEmail(file).html).toContain('&lt;b&gt;');
  });

  it('failed source wins over stray bullets', () => {
    const file = makeFile(`## Hacker News\n${bullet(1)}\nSource unavailable.`);
    expect(file.brief.hackerNews).toEqual([]);
    expect(briefHackerNews(file)?.message).toBe('Source unavailable.');
  });
});
