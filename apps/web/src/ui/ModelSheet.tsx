// LB1 (ADR-0065): one model's detail sheet — specs, index bars, and every published evaluation with a plain
// explanation of what it measures. Read-only; values are the provider's, never derived or invented.
import { LEADERBOARD_CATEGORY_INFO, LEADERBOARD_METHODOLOGY_URL, type LeaderboardCategoryId, type LeaderboardModel } from '@vault-companion/contracts';
import { SheetHeader } from './SheetHeader.tsx';
import './Leaderboard.css';
import { barRatio, benchmarkMeta, formatBenchmark, formatScore, specRows } from './leaderboard.ts';

const INDEX_ORDER: { id: LeaderboardCategoryId; key: 'overall' | 'coding' | 'agentic' | 'math' }[] = [
  { id: 'overall', key: 'overall' },
  { id: 'coding', key: 'coding' },
  { id: 'agentic', key: 'agentic' },
  { id: 'math', key: 'math' },
];

export function ModelSheet({ model, onClose }: { model: LeaderboardModel; onClose: () => void }) {
  const specs = specRows(model);
  const indices = INDEX_ORDER.map(({ id, key }) => ({ id, label: LEADERBOARD_CATEGORY_INFO[id].label, score: model.scores[key] }));
  const best = Math.max(...indices.map((index) => index.score ?? 0), 1);
  const movement =
    model.movement === null ? null
    : model.movement.isNew ? 'New to the leaderboard'
    : model.movement.rankDelta > 0 ? `Up ${model.movement.rankDelta} in the overall ranking since the previous snapshot`
    : model.movement.rankDelta < 0 ? `Down ${Math.abs(model.movement.rankDelta)} in the overall ranking since the previous snapshot`
    : 'Same overall rank as the previous snapshot';

  return (
    <div className="sheet-backdrop" role="presentation">
      <section className="sheet model-sheet" role="dialog" aria-modal="true" aria-label={model.name}>
        <SheetHeader title={model.name} onClose={onClose} />
        {model.provider !== null && <p className="muted small">{model.provider}</p>}
        {movement !== null && <p className="muted small">{movement}</p>}
        {specs.length > 0 && (
          <div className="lb-sheet-rows">
            {specs.map((row) => (
              <div className="lb-sheet-row" key={row.label}><span className="muted">{row.label}</span><span className="value">{row.value}</span></div>
            ))}
          </div>
        )}
        <h3>Indices (0–100)</h3>
        {indices.map((index) => (
          <div className="lb-score-line" key={index.id}>
            <span className="lb-score-label">{index.label}</span>
            <span className="lb-score-bar"><span style={{ width: `${Math.round(barRatio(index.score, best) * 100)}%` }} /></span>
            <span className="lb-score-value">{formatScore(index.score)}</span>
          </div>
        ))}
        <p className="lb-explain">The bars compare this model's own indices. {LEADERBOARD_CATEGORY_INFO.overall.blurb}</p>
        {model.benchmarks.length > 0 ? (
          <>
            <h3>Individual evaluations</h3>
            {model.benchmarks.map((benchmark) => {
              const meta = benchmarkMeta(benchmark.key);
              return (
                <div key={benchmark.key}>
                  <div className="lb-sheet-row"><span>{meta.label}</span><span className="value">{formatBenchmark(benchmark.value)}</span></div>
                  <p className="lb-explain">{meta.explainer}</p>
                </div>
              );
            })}
            <p className="lb-explain">Values are shown on each evaluation's own scale, so they are listed rather than drawn.</p>
          </>
        ) : <p className="lb-empty-note">No individual evaluation scores are published for this model on this data tier.</p>}
        <p className="lb-meta">Values published by <a href={LEADERBOARD_METHODOLOGY_URL} target="_blank" rel="noopener noreferrer">Artificial Analysis</a>. Benchmarks measure specific tasks, not overall real-world quality.</p>
      </section>
    </div>
  );
}
