// Small labelled bar chart for iPhone-mode cards (UI refresh slice 4). Colour comes from the card's --chart token.
import type { Bar } from '../week-chart.ts';

const W = 320;
const H = 120;
const PLOT = 88; // bar area height; labels sit underneath

export function BarChart({ title, bars, testId }: { title: string; bars: readonly Bar[]; testId?: string }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const slot = W / bars.length;
  const width = Math.min(28, slot * 0.6);
  return <figure className="bar-chart" data-testid={testId}>
    <figcaption>{title}</figcaption>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${b.value}`).join(', ')}`}>
      {bars.map((b, i) => {
        const x = i * slot + (slot - width) / 2;
        const h = b.value === 0 ? 2 : Math.max(4, (b.value / max) * (PLOT - 16));
        return <g key={b.label} className={b.current ? 'bar bar-current' : 'bar'}>
          <rect x={x} y={PLOT - h} width={width} height={h} rx={4} />
          {b.value > 0 && <text x={x + width / 2} y={PLOT - h - 4} className="bar-value">{b.value}</text>}
          <text x={x + width / 2} y={H - 8} className="bar-label">{b.label}</text>
        </g>;
      })}
    </svg>
  </figure>;
}
