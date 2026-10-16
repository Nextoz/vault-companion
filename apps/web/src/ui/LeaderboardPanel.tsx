// LB1 (ADR-0065): the Dashboard's AI model leaderboard. One tab per ranked category, the top 10 rows with score,
// movement and strongest capability, and a detail sheet per model. Read-only, fed from App like AiUsagePanel.
import { LEADERBOARD_CATEGORY_INFO, LEADERBOARD_METHODOLOGY_URL, type LeaderboardCategoryId, type LeaderboardResponse } from '@vault-companion/contracts';
import { useState } from 'react';
import type { Fetched } from '../api.ts';
import './Leaderboard.css';
import { ModelSheet } from './ModelSheet.tsx';
import { barRatio, formatScore, leaderboardCategories, leaderboardFresh, leaderboardNote, leaderboardRows, strongestCapability } from './leaderboard.ts';

const updated = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const formatSynced = (iso: string): string => `${updated.format(Date.parse(iso))} UTC`;
const rowClass = (movement: string | null): string =>
  movement === null ? '' : movement === 'New' ? 'lb-row-new' : movement.startsWith('↑') ? 'lb-row-up' : 'lb-row-down';

export function LeaderboardPanel({ view, now }: { view: Fetched<LeaderboardResponse> | null; now: number }) {
  const [category, setCategory] = useState<LeaderboardCategoryId>('overall');
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const response = view?.kind === 'ok' ? view.data : null;
  const failed = view !== null && view.kind !== 'ok';
  const categories = response !== null ? leaderboardCategories(response) : [];
  const active: LeaderboardCategoryId = categories.includes(category) ? category : (categories[0] ?? 'overall');
  const rows = response !== null ? leaderboardRows(response, active) : [];
  const best = rows.reduce((max, row) => Math.max(max, row.score ?? 0), 0);
  const open = response?.status === 'ok' && openSlug !== null ? response.models.find((model) => model.slug === openSlug) ?? null : null;
  const fresh = response !== null && response.status === 'ok' && leaderboardFresh(response, now);

  return (
    <section className="lb-panel" aria-label="AI models">
      <div className="lb-head">
        <h3>AI models</h3>
        {response?.status === 'ok' && <span className={`dash-chip dash-chip-${fresh ? 'live' : 'stale'}`}>{fresh ? 'Live' : 'Stale'}</span>}
      </div>
      {view === null && <p className="muted small" role="status">Loading…</p>}
      {failed && <p className="dash-note" role="status">The leaderboard could not be loaded. No values are shown.</p>}
      {response?.status === 'unavailable' && <p className="dash-note" role="status">{leaderboardNote(response)}</p>}
      {response?.status === 'ok' && (
        <>
          <div className="segmented" role="group" aria-label="Leaderboard category">
            {categories.map((id) => (
              <button key={id} type="button" aria-pressed={active === id} onClick={() => setCategory(id)}>{LEADERBOARD_CATEGORY_INFO[id].label}</button>
            ))}
          </div>
          <p className="lb-meta">{LEADERBOARD_CATEGORY_INFO[active].blurb}</p>
          <ol className="lb-list">
            {rows.map((row) => (
              <li key={row.model.slug}>
                <button type="button" className={`lb-row ${rowClass(row.movement)}`} onClick={() => setOpenSlug(row.model.slug)}>
                  <span className="lb-rank">{row.rank}</span>
                  <span className="lb-main">
                    <span className="lb-name">{row.model.name}</span>
                    <span className="lb-sub">{row.model.provider ?? 'Unknown provider'}{strongestCapability(row.model) !== null ? ` · strong at ${strongestCapability(row.model)}` : ''}</span>
                    <span className="lb-bar"><span style={{ width: `${Math.round(barRatio(row.score, best) * 100)}%` }} /></span>
                  </span>
                  <span className="lb-side">
                    <span className="lb-score">{formatScore(row.score)}</span>
                    <span className="lb-movement">{row.movement ?? ''}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="lb-meta">
            Last updated {formatSynced(response.syncedAt)}
            {response.intelligenceIndexVersion !== null ? ` · Intelligence Index v${response.intelligenceIndexVersion}` : ''} ·{' '}
            <a href={LEADERBOARD_METHODOLOGY_URL} target="_blank" rel="noopener noreferrer">{response.provenance}</a>
          </p>
          <p className="lb-note">Benchmarks measure specific tasks under fixed conditions, not overall real-world quality.</p>
        </>
      )}
      {open !== null && <ModelSheet model={open} onClose={() => setOpenSlug(null)} />}
    </section>
  );
}
