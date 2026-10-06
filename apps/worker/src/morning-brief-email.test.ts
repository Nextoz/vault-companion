import { describe, expect, it } from 'vitest';
import type { BriefFile } from '@vault-companion/domain';
import { cloudflareMailer, renderBriefEmail } from './morning-brief-email.ts';

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

  it('escapes hostile stateLine, gap times, due date, file.date and unavailable in the HTML', () => {
    const hostile = '<img src=x onerror=1>';
    const { html } = renderBriefEmail(
      file({
        date: hostile,
        unavailable: [hostile],
        brief: {
          meetings: [],
          source: 'model',
          dayLine: 'ok',
          stateLine: hostile,
          gaps: [{ blockIndex: 0, start: hostile, end: hostile }],
          todos: [{ id: 0, text: 'ok', due: hostile, bill: false }],
        },
      }),
    );
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=1&gt;/g)?.length).toBe(6);
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
