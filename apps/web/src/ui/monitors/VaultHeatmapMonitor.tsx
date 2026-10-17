// M6: the Vault heatmap monitor. It reads the vault activity file through the Worker and draws a GitHub-style
// 26-week grid of distinct notes touched per day. A failed read says so instead of showing a number.
import { VaultActivityResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getJson, type Fetched } from '../../api.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import { projectVaultHeatmap, type VaultHeatmap } from './vault-heatmap.ts';
import './VaultHeatmapMonitor.css';

export const VAULT_HEATMAP_FAILED = 'Vault activity could not be read.';
export const VAULT_HEATMAP_MISSING = 'No vault activity has been published yet.';
export const VAULT_HEATMAP_LOADING = 'Loading vault activity…';

const PITCH = 9.5;
const CELL = 8;
const TOP = 14;
const AREA_COLOURS = ['var(--ios-indigo)', 'var(--ios-green)', 'var(--ios-orange)', 'var(--ios-cyan)', 'var(--ios-yellow)', 'var(--muted)'];

export const getVaultActivity = () => getJson('/api/monitors/vault-activity', VaultActivityResponse.strip());

function Grid({ view }: { view: VaultHeatmap }) {
  const width = Math.max(view.cols * PITCH - (PITCH - CELL), CELL);
  return (
    <svg className="vh-grid" viewBox={`0 0 ${width} ${TOP + 7 * PITCH}`} width="100%" role="img" aria-label="Note activity, last 26 weeks">
      {view.monthLabels.map((m) => <text key={m.label + m.col} x={m.col * PITCH} y={8}>{m.label}</text>)}
      {view.cells.map((c) => (
        <rect key={c.date} className={`vh-cell vh-l${c.level}${c.today ? ' vh-today' : ''}`} x={c.col * PITCH} y={TOP + c.row * PITCH}
          width={CELL} height={CELL} rx={2}>
          <title>{c.date}: {c.notes} {c.notes === 1 ? 'note' : 'notes'}</title>
        </rect>
      ))}
    </svg>
  );
}

function Body({ view }: { view: VaultHeatmap }) {
  return (
    <div className="vh-body">
      <p className="vh-streak">Current streak <b>{view.streakDays} {view.streakDays === 1 ? 'day' : 'days'}</b><br />
        <span className="muted small">{view.monthNotes} notes touched this month</span></p>
      <Grid view={view} />
      <div className="vh-legend" aria-hidden="true">Less{[0, 1, 2, 3, 4].map((l) => <i key={l} className={`vh-l${l}`} />)}More</div>
      {view.areas.length > 0 && (
        <>
          <p className="vh-section">NOTES BY AREA · 30 DAYS</p>
          <div className="vh-stack" aria-hidden="true">
            {view.areas.map((a, i) => <span key={a.area} style={{ flexGrow: a.notes, background: AREA_COLOURS[i] }} />)}
          </div>
          <ul className="vh-areas">
            {view.areas.map((a, i) => (
              <li key={a.area}><i style={{ background: AREA_COLOURS[i] }} aria-hidden="true" />{a.area} {a.notes}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function VaultHeatmapMonitor({ nowMs }: { nowMs?: number | undefined }) {
  const [res, setRes] = useState<Fetched<VaultActivityResponse> | null>(null);
  useEffect(() => {
    let live = true;
    void getVaultActivity().then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, []);

  const view = res?.kind === 'ok' ? projectVaultHeatmap(res.data, nowMs ?? Date.now()) : null;
  const unavailable = res === null ? VAULT_HEATMAP_LOADING
    : view === null ? (res.kind === 'error' && /404/.test(res.message) ? VAULT_HEATMAP_MISSING : VAULT_HEATMAP_FAILED)
      : null;
  return (
    <MonitorCard
      title="Vault heatmap"
      className="vault-heatmap"
      status={unavailable === null ? undefined : <p className="dash-note" role="status">{unavailable}</p>}
      summary={<p className="vh-summary">{view?.summary}</p>}
      footer={view && <p className={view.stale ? 'dash-stale vh-foot' : 'muted small vh-foot'} role="status">{view.footer}</p>}>
      {view && <Body view={view} />}
    </MonitorCard>
  );
}
