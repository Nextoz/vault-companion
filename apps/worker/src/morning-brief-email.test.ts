import { describe, expect, it } from 'vitest';
import { briefTimeline } from '@vault-companion/contracts';
import type { BriefFile } from '@vault-companion/domain';
import { cloudflareMailer, escapeHtml, renderBriefEmail } from './morning-brief-email.ts';

const decode = (b64: string): string => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

const DATE = '2026-06-15';

const file = (over: Partial<BriefFile> = {}): BriefFile => ({
  schemaVersion: 2,
  date: DATE,
  generatedAt: `${DATE}T04:30:05Z`,
  source: 'model',
  unavailable: ['mail'],
  unavailableReasons: {},
  brief: {
    meetings: [],
    source: 'model',
    dayLine: 'A short day with room to breathe.',
    stateLine: 'steps above its 30-day median',
    gaps: [{ blockIndex: 0, start: `${DATE}T07:00:00Z`, end: `${DATE}T08:30:00Z`, suggestion: 'Take a walk.' }],
    todos: [{ id: 0, text: 'Pay the rent', due: DATE, bill: true, firstStep: 'Open the letter.' }],
    encouragement: 'One step is enough.',
  },
  ...over,
});

describe('renderBriefEmail', () => {
  it('uses the brief date in the subject and renders every section', () => {
    const { subject, text, html } = renderBriefEmail(file());
    expect(subject).toBe(`Morning Brief - ${DATE}`);
    for (const value of ['A short day with room to breathe.', 'steps above its 30-day median', 'Take a walk.', 'Pay the rent', DATE, 'Open the letter.', 'One step is enough.', 'Mail unavailable: reason not provided']) {
      expect(text).toContain(value);
      expect(html).toContain(value);
    }
  });

  it('escapes HTML in every interpolated string but leaves the text body raw', () => {
    const attack = '<script>alert("x")</script>';
    const dangerous = file({
      brief: {
        meetings: [],
        source: 'model',
        dayLine: attack,
        gaps: [{ blockIndex: 0, start: `${DATE}T07:00:00Z`, end: `${DATE}T08:30:00Z`, suggestion: attack }],
        todos: [{ id: 0, text: attack, due: null, bill: false, firstStep: attack }],
        encouragement: attack,
      },
    });
    const { text, html } = renderBriefEmail(dangerous);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;x&quot;');
    // The plain-text body is not HTML: it keeps the raw string.
    expect(text).toContain(attack);
  });

  it('escapes hostile timeline text, stateLine, due date, file.date and unavailable in the HTML', () => {
    const hostile = '<img src=x onerror=1>';
    const { html } = renderBriefEmail(
      file({
        date: hostile,
        unavailable: [hostile],
        brief: {
          meetings: [{ title: hostile, start: `${DATE}T09:00:00Z`, end: `${DATE}T10:00:00Z`, allDay: false, clash: false }],
          source: 'model',
          dayLine: 'ok',
          stateLine: hostile,
          gaps: [{ blockIndex: 0, start: `${DATE}T10:00:00Z`, end: `${DATE}T11:00:00Z`, suggestion: hostile }],
          todos: [{ id: 0, text: 'ok', due: hostile, bill: false }],
        },
      }),
    );
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=1&gt;/g)?.length).toBe(6);
  });

  it('renders the timeline rows from the shared helper, in the same order as the phone sheet', () => {
    const withMeetings = file({ unavailable: [], brief: {
      meetings: [
        { title: 'Team sync', start: `${DATE}T09:30:00+02:00`, end: `${DATE}T10:30:00+02:00`, allDay: false, clash: true, clashWith: 'Design review' },
        { title: 'Design review', start: `${DATE}T09:00:00+02:00`, end: `${DATE}T10:00:00+02:00`, allDay: false, clash: true, clashWith: 'Team sync' },
      ],
      source: 'model', dayLine: 'A day.', gaps: [{ blockIndex: 0, start: `${DATE}T07:00:00+02:00`, end: `${DATE}T08:00:00+02:00`, suggestion: 'Take a walk' }], todos: [],
    } });
    const timeline = briefTimeline(withMeetings, new Date(`${DATE}T12:00:00+02:00`));
    const { text, html } = renderBriefEmail(withMeetings, new Date(`${DATE}T12:00:00+02:00`));
    let cursor = 0;
    for (const row of timeline.rows) {
      const label = `${row.time}  ${row.label}`;
      expect(text.indexOf(label, cursor)).toBeGreaterThan(-1);
      cursor = text.indexOf(label, cursor);
      expect(html).toContain(escapeHtml(row.label));
      if (row.overlap !== null) expect(text).toContain(row.overlap);
    }
    expect(text).not.toContain('Free blocks:');
  });

  it('renders a fallback brief without inventing suggestion, firstStep, state or encouragement text', () => {
    const fallback = file({
      source: 'fallback',
      brief: {
        meetings: [],
        source: 'fallback',
        dayLine: `${DATE}: 1 free block(s), 1 todo candidate(s).`,
        gaps: [{ blockIndex: 0, start: `${DATE}T07:00:00Z`, end: `${DATE}T08:30:00Z` }],
        todos: [{ id: 0, text: 'Pay the rent', due: null, bill: false }],
      },
    });
    const { text, html } = renderBriefEmail(fallback);
    for (const output of [text, html]) {
      expect(output).not.toContain('First step');
      expect(output).not.toContain('State:');
      expect(output).not.toContain('undefined');
      expect(output).toContain('Mail unavailable: reason not provided');
    }
  });

  it('renders the full digest sections and lets One thing replace the generic closing line', () => {
    const withDigest = file({ unavailable: [], brief: {
      meetings: [], source: 'model', dayLine: 'A day.', gaps: [], todos: [], encouragement: 'Generic closing.',
      needsYou: [{ title: 'Synthetic Mail', line: 'A synthetic message.', url: 'https://mail.google.com/mail/u/0/#inbox/synthetic' }],
      copenhagen: [{ title: '17:00 Synthetic Event', line: 'A synthetic plan.', url: 'https://www.google.com/calendar/event?eid=synthetic' }],
      news: [{ title: 'Synthetic Headline', line: 'A synthetic one-liner.', url: 'https://example.test/news' }],
      research: [{ title: 'Synthetic Study', line: 'A synthetic finding.', url: 'https://example.test/paper' }],
      oneThing: { text: 'A synthetic thought.', quote: 'A synthetic quote.' },
    } });
    const { text, html } = renderBriefEmail(withDigest);
    for (const output of [text, html]) {
      expect(output).toContain('Synthetic Mail');
      expect(output).toContain('A synthetic message.');
      expect(output).toContain('17:00 Synthetic Event');
      expect(output).toContain('A synthetic plan.');
      expect(output).toContain('Synthetic Headline');
      expect(output).toContain('A synthetic one-liner.');
      expect(output).toContain('Synthetic Study');
      expect(output).toContain('A synthetic thought.');
      expect(output).toContain('A synthetic quote.');
      expect(output).not.toContain('Generic closing.');
    }
    expect(text).toContain('Needs you');
    expect(text).toContain('Copenhagen today');
    expect(html).toContain('href="https://mail.google.com/mail/u/0/#inbox/synthetic"');
    expect(html).toContain('href="https://www.google.com/calendar/event?eid=synthetic"');
    expect(html).toContain('href="https://example.test/news"');
  });

  it('renders per-section unavailable lines, never a bare Digest reader line, for a missing note', () => {
    const missingDigest = file({ unavailable: ['mail', 'digest'], unavailableReasons: { digest: 'not-found' } });
    const { text, html } = renderBriefEmail(missingDigest);
    for (const output of [text, html]) {
      expect(output).toContain('News unavailable: the note was not found');
      expect(output).toContain('AI and research unavailable: the note was not found');
      expect(output).not.toContain('Digest unavailable');
    }
  });
});

describe('cloudflareMailer', () => {
  it('builds a base64 UTF-8 multipart MIME message and hands it to the binding', async () => {
    const sent: unknown[] = [];
    const created: [string, string, string][] = [];
    const mailer = cloudflareMailer(
      { send: async (message) => { sent.push(message); } },
      'briefs@example.com',
      'owner@example.com',
      (from, to, raw) => { created.push([from, to, raw]); return { marker: 'msg' }; },
    );
    const subject = 'Morning Brief - æøå\r\nBcc: x@evil.test';
    await mailer.send({ subject, text: 'text bødy', html: '<p>html bødy</p>' });
    expect(sent).toEqual([{ marker: 'msg' }]);
    const [from, to, raw] = created[0]!;
    expect([from, to]).toEqual(['briefs@example.com', 'owner@example.com']);
    expect(raw).toContain('From: briefs@example.com\r\nTo: owner@example.com\r\n');
    expect(raw).toContain('multipart/alternative');
    // header injection: a CRLF in the subject is encoded away and never becomes a header of its own
    expect(raw).not.toMatch(/^Bcc:/m);
    const encoded = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(raw)![1]!;
    expect(decode(encoded)).toBe(subject);
    const bodies = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) =>
      decode(m[1]!.replace(/\r\n/g, '')),
    );
    expect(bodies).toEqual(['text bødy', '<p>html bødy</p>']);
  });
});
