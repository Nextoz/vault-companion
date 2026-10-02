import { describe, expect, it } from 'vitest';
import type { BriefFile } from '@vault-companion/domain';
import { cloudflareMailer, renderBriefEmail } from './morning-brief-email.ts';

const DATE = '2026-06-15';

const file = (over: Partial<BriefFile> = {}): BriefFile => ({
  schemaVersion: 1,
  date: DATE,
  generatedAt: `${DATE}T04:30:05Z`,
  source: 'model',
  unavailable: ['mail'],
  brief: {
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
    for (const value of ['A short day with room to breathe.', 'steps above its 30-day median', 'Take a walk.', 'Pay the rent', DATE, 'Open the letter.', 'One step is enough.', 'mail']) {
      expect(text).toContain(value);
      expect(html).toContain(value);
    }
  });

  it('escapes HTML in every interpolated string but leaves the text body raw', () => {
    const attack = '<script>alert("x")</script>';
    const dangerous = file({
      brief: {
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

  it('renders a fallback brief without inventing suggestion, firstStep, state or encouragement text', () => {
    const fallback = file({
      source: 'fallback',
      brief: {
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
      expect(output).toContain('Unavailable: mail');
    }
  });
});

describe('cloudflareMailer', () => {
  it('sends from/to with the rendered subject, text and html through the binding', async () => {
    const sent: unknown[] = [];
    const mailer = cloudflareMailer({ send: async (message) => { sent.push(message); } }, 'briefs@example.com', 'owner@example.com');
    await mailer.send({ subject: 'Morning Brief - 2026-06-15', text: 'text body', html: '<p>html body</p>' });
    expect(sent).toEqual([{ from: 'briefs@example.com', to: 'owner@example.com', subject: 'Morning Brief - 2026-06-15', text: 'text body', html: '<p>html body</p>' }]);
  });
});
