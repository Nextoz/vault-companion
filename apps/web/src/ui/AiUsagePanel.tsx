// AB3b: the Dashboard's one AI usage panel. It only draws what the usage projection and the budget rows hand it; a
// failed read says so instead of showing a number, and a missing budget row simply means no "left" line.
// Owner request: compact by default. The heading's button is the disclosure; the collapsed body is one summary row per
// provider, and every mount starts collapsed (no persistence).
import type { AiBudgetResponse, AiUsageResponse } from '@vault-companion/contracts';
import { useId, useState } from 'react';
import type { Fetched } from '../api.ts';
import { aiUsageDayLabel, aiUsageSpark, aiUsageTiles, formatAiUsageValue, type AiUsageMetric, type AiUsageRange, type AiUsageTile } from './ai-usage.ts';
import './Dashboard.css';

export const AI_USAGE_EMPTY = 'No AI usage has been recorded yet.';
export const AI_USAGE_FAILED = 'AI usage could not be read.';

const METRIC_LABEL: Record<AiUsageMetric, string> = { tokens: 'tokens', calls: 'calls', cost: 'cost' };

function Sparkline({ tile, range }: { tile: AiUsageTile; range: AiUsageRange }) {
  const { segments, dots } = aiUsageSpark(tile, 160, 36, 3);
  return (
    <svg className="ai-usage-spark" viewBox="0 0 160 36" preserveAspectRatio="none" role="img"
      aria-label={`${tile.title}: ${range} days of ${METRIC_LABEL[tile.metric]}`}>
      {segments.map((segment, index) => <polyline key={index} points={segment.join(' ')} />)}
      {dots.map((dot, index) => {
        const [cx, cy] = dot.split(',');
        return <circle key={index} cx={cx} cy={cy} r={2} />;
      })}
    </svg>
  );
}

function Tile({ tile, range }: { tile: AiUsageTile; range: AiUsageRange }) {
  return (
    <div className="ai-usage-tile">
      <h3 className="ai-usage-provider">{tile.title}</h3>
      <p className="ai-usage-value">{tile.total === null ? 'Usage unavailable'
        : `${formatAiUsageValue(tile.metric, tile.currency, tile.total)} ${tile.metric === 'cost' ? `cost${tile.currency ? '' : ' (currency unknown)'}` : METRIC_LABEL[tile.metric]}`}</p>
      {tile.windowStart && tile.windowEnd && <p className="ai-usage-period muted small">
        {aiUsageDayLabel(tile.windowStart)}–{aiUsageDayLabel(tile.windowEnd)} · {range} days
      </p>}
      {tile.metric === 'tokens' && tile.total !== null && <p className="muted small ai-usage-note">Output + cache-write</p>}
      {tile.left !== null && <p className={`ai-usage-left ai-usage-left-${tile.leftTone ?? 'ok'}`}>Budget: {tile.left}</p>}
      {tile.points.length > 0 && <Sparkline tile={tile} range={range} />}
      {tile.note && <p className="ai-usage-note muted small">{tile.note}</p>}
    </div>
  );
}

/** One collapsed row on a single line: provider title left (ellipsis when long), the budget row's dot + text in
 * its own tone, then the same formatted number the tile shows, right-aligned. Cost keeps its currency sign. */
function SummaryRow({ tile }: { tile: AiUsageTile }) {
  return (
    <li className="ai-usage-row">
      <span className="ai-usage-provider">{tile.title}</span>
      {tile.left !== null && (
        <span className={`ai-usage-row-left ai-usage-left-${tile.leftTone ?? 'ok'}`}>
          <span className="ai-usage-dot" aria-hidden="true" />
          {tile.left}
        </span>
      )}
      <span className="ai-usage-row-value">{tile.total === null ? 'Usage unavailable'
        : `${formatAiUsageValue(tile.metric, tile.currency, tile.total)}${tile.metric === 'cost' ? '' : ` ${METRIC_LABEL[tile.metric]}`}`}</span>
    </li>
  );
}

export function AiUsagePanel({ usage, budget, now, timeZone = 'Europe/Copenhagen', onRetry }: {
  usage: Fetched<AiUsageResponse> | null;
  budget: Fetched<AiBudgetResponse> | null;
  now: number;
  timeZone?: string;
  onRetry?: (() => void) | undefined;
}) {
  const headingId = useId();
  const bodyId = useId();
  const [range, setRange] = useState<AiUsageRange>(7);
  const [expanded, setExpanded] = useState(false);
  if (usage === null) return null;
  const view = usage.kind === 'ok'
    ? aiUsageTiles(usage.data, budget?.kind === 'ok' ? budget.data : null, now, timeZone, range)
    : null;
  return (
    <section className="dash-card ai-usage" aria-labelledby={headingId}>
      <header className="dash-card-head">
        <h2 id={headingId}>
          <button type="button" className="ai-usage-head" aria-expanded={expanded} aria-controls={bodyId}
            onClick={() => setExpanded((open) => !open)}>
            AI usage
            <svg className="ai-usage-chevron" aria-hidden="true" focusable="false" viewBox="0 0 12 12" width="12" height="12">
              <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </h2>
        {expanded && view && view.tiles.length > 0 && (
          <div className="segmented ai-usage-range" role="group" aria-label="AI usage range">
            <button type="button" aria-pressed={range === 7} onClick={() => setRange(7)}>7 d</button>
            <button type="button" aria-pressed={range === 30} onClick={() => setRange(30)}>30 d</button>
          </div>
        )}
      </header>
      <div className="ai-usage-body" id={bodyId}>
        {view === null ? (
          <div className="ai-usage-failure">
            <p className="dash-note" role="status">{AI_USAGE_FAILED}</p>
            {onRetry && <button type="button" className="link" onClick={onRetry}>Retry</button>}
          </div>
        ) : view.tiles.length === 0 ? (
          <p className="dash-note" role="status">{AI_USAGE_EMPTY}</p>
        ) : expanded ? (
          <div className="ai-usage-tiles">
            {view.tiles.map((tile) => <Tile key={tile.id} tile={tile} range={range} />)}
          </div>
        ) : (
          <ul className="ai-usage-summary">
            {view.tiles.map((tile) => <SummaryRow key={tile.id} tile={tile} />)}
          </ul>
        )}
        {view?.freshness && (
          <p className={view.freshness.stale ? 'dash-stale ai-usage-updated' : 'muted small ai-usage-updated'} role="status">
            {view.freshness.text}
          </p>
        )}
      </div>
    </section>
  );
}
