// AB3b: the Dashboard's one AI usage panel. It only draws what the usage projection and the budget rows hand it; a
// failed read says so instead of showing a number, and a missing budget row simply means no "left" line.
import type { AiBudgetResponse, AiUsageResponse } from '@vault-companion/contracts';
import { useId, useState } from 'react';
import type { Fetched } from '../api.ts';
import { aiUsageSpark, aiUsageTiles, type AiUsageMetric, type AiUsageRange, type AiUsageTile } from './ai-usage.ts';
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
      {tile.left !== null && <p className={`ai-usage-left ai-usage-left-${tile.leftTone ?? 'ok'}`}>{tile.left}</p>}
      {tile.points.length > 0 && <Sparkline tile={tile} range={range} />}
      {tile.note && <p className="ai-usage-note muted small">{tile.note}</p>}
    </div>
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
  const [range, setRange] = useState<AiUsageRange>(7);
  if (usage === null) return null;
  const view = usage.kind === 'ok'
    ? aiUsageTiles(usage.data, budget?.kind === 'ok' ? budget.data : null, now, timeZone, range)
    : null;
  return (
    <section className="dash-card ai-usage" aria-labelledby={headingId}>
      <header className="dash-card-head">
        <h2 id={headingId}>AI usage</h2>
        {view && view.tiles.length > 0 && (
          <div className="segmented ai-usage-range" role="group" aria-label="AI usage range">
            <button type="button" aria-pressed={range === 7} onClick={() => setRange(7)}>7 d</button>
            <button type="button" aria-pressed={range === 30} onClick={() => setRange(30)}>30 d</button>
          </div>
        )}
      </header>
      {view === null ? (
        <div className="ai-usage-failure">
          <p className="dash-note" role="status">{AI_USAGE_FAILED}</p>
          {onRetry && <button type="button" className="link" onClick={onRetry}>Retry</button>}
        </div>
      ) : view.tiles.length === 0 ? (
        <p className="dash-note" role="status">{AI_USAGE_EMPTY}</p>
      ) : (
        <div className="ai-usage-tiles">
          {view.tiles.map((tile) => <Tile key={tile.id} tile={tile} range={range} />)}
        </div>
      )}
      {view?.freshness && (
        <p className={view.freshness.stale ? 'dash-stale ai-usage-updated' : 'muted small ai-usage-updated'} role="status">
          {view.freshness.text}
        </p>
      )}
    </section>
  );
}
