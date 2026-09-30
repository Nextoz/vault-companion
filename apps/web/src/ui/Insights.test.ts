import type { ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Insights } from './Insights.tsx';

const NOW = '2026-09-30T12:00:00+02:00';
const status = (scoutId: string, extra: Partial<ScoutStatus> = {}): ScoutStatus => ({
  schemaVersion: 1, scoutId, displayName: scoutId, schedule: 'daily', expectedEveryHours: 24,
  lastAttemptAt: null, lastSuccessAt: null, runStatus: null, sources: null, aiHealth: null,
  findings: null, added: null, errors: null, lastError: null, latestOutput: null, history: [], ...extra,
});

/** Server-renders one card with no output reads settled (`useEffect` does not run), so only the card logic shows. */
function renderCard(scoutId: string, scoutStatus: ScoutStatus): { html: string; text: string } {
  const data: ScoutsResponse = {
    revision: 'a'.repeat(40), now: NOW,
    scouts: [{ state: 'ok', file: `${scoutId}.json`, status: scoutStatus }],
  };
  const html = renderToStaticMarkup(createElement(Insights, { data, hidden: false, onSelect: () => {} }));
  const article = new JSDOM(html).window.document.querySelector('article')!;
  return { html: article.outerHTML, text: article.textContent ?? '' };
}

describe('Insights cards (B3)', () => {
  it('shows a degraded run as today with its own count and a human reason', () => {
    const { text } = renderCard('daily-research', status('daily-research', {
      displayName: 'Daily research',
      lastAttemptAt: '2026-09-30T06:31:00+02:00',
      lastSuccessAt: '2026-09-29T07:00:00+02:00',
      runStatus: 'degraded',
      findings: 5,
      sources: { configured: 8, successful: 3 },
      latestOutput: 'Discoveries/Daily research.md',
      history: [{ at: '2026-09-29T07:00:00+02:00', status: 'success', findings: 3 }],
    }));
    expect(text).toContain('5 findings');
    expect(text).not.toContain('3 findings');
    expect(text).toContain('Ran with problems');
    expect(text).toContain('5 sources failed');
    expect(text).toContain('Picks from');
    expect(text).toContain('Today 06:31');
    expect(text).not.toContain('Yesterday');
  });

  it('still says "Ran with problems" without a reason, and bounds a long error', () => {
    const bare = renderCard('bare', status('bare', {
      runStatus: 'degraded', findings: 0, lastAttemptAt: NOW, latestOutput: 'Discoveries/Bare.md',
    }));
    expect(bare.text).toContain('0 findings');
    expect(bare.text).toContain('Ran with problems');
    expect(bare.text).not.toContain('\u2014');

    const noisy = renderCard('noisy', status('noisy', {
      runStatus: 'degraded', findings: 1, lastAttemptAt: NOW, lastError: 'x'.repeat(400),
    }));
    expect(noisy.text).toContain('Ran with problems');
    expect(noisy.text).not.toContain('x'.repeat(400));
  });

  it('keeps failed and stale pick previews suppressed', () => {
    const failed = renderCard('failed', status('failed', {
      displayName: 'Failed scout', runStatus: 'failed', lastAttemptAt: NOW,
      lastSuccessAt: '2026-09-29T07:00:00+02:00', findings: 4, latestOutput: 'Discoveries/Failed.md',
      history: [{ at: '2026-09-29T07:00:00+02:00', status: 'success', findings: 4 }],
    }));
    expect(failed.text).toContain('Failed');
    expect(failed.text).not.toContain('Picks from');
    expect(failed.text).not.toContain('Open scout to see findings');
    expect(failed.text).not.toContain('Ran with problems');

    const stale = renderCard('stale', status('stale', {
      displayName: 'Stale scout', runStatus: 'success', lastAttemptAt: '2026-09-25T07:00:00+02:00',
      lastSuccessAt: '2026-09-25T07:00:00+02:00', findings: 2, latestOutput: 'Discoveries/Stale.md',
      history: [{ at: '2026-09-25T07:00:00+02:00', status: 'success', findings: 2 }],
    }));
    expect(stale.text).toContain('Stale');
    expect(stale.text).not.toContain('Picks from');
    expect(stale.text).not.toContain('Open scout to see findings');

    const healthy = renderCard('healthy', status('healthy', {
      displayName: 'Healthy scout', runStatus: 'success', lastAttemptAt: NOW, lastSuccessAt: NOW,
      findings: 4, latestOutput: 'Discoveries/Healthy.md',
    }));
    expect(healthy.text).toContain('Picks from');
    expect(healthy.text).toContain('Open scout to see findings');
  });
});
