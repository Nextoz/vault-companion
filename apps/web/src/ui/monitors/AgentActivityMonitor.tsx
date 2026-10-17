// M2: the Agent activity monitor. It reads the agent activity file through the Worker (PRs, CI and deploy from
// GitHub, spend from the usage ledger, owner items from the Lead's action log) and shows the last 24 hours.
// A failed read says so instead of showing a number; a missing spend value is left out, never shown as zero.
import { AgentActivityResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getJson, type Fetched } from '../../api.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import { projectAgentActivity, type AgentActivityView } from './agent-activity.ts';
import './AgentActivityMonitor.css';

export const AGENT_ACTIVITY_FAILED = 'Agent activity could not be read.';
export const AGENT_ACTIVITY_MISSING = 'No agent activity has been published yet.';
export const AGENT_ACTIVITY_LOADING = 'Loading agent activity…';

export const getAgentActivity = () => getJson('/api/monitors/agent-activity', AgentActivityResponse.strip());

function Body({ view }: { view: AgentActivityView }) {
  return (
    <div className="aa-body">
      <p className="aa-ci">{view.ciLabel}</p>
      <p className="aa-section">MERGED · LAST 24 H</p>
      {view.merged.length === 0 ? (
        <p className="muted small">No pull request was merged in the last 24 hours.</p>
      ) : (
        <ul className="aa-list">
          {view.merged.map((pr) => (
            <li key={pr.number} className="aa-row">
              <span className="aa-title">#{pr.number} · {pr.title}<br />
                <span className="muted small">{pr.meta}{pr.change ? ` · ${pr.change}` : ''}</span></span>
              <span className="aa-chip aa-chip-ok">merged</span>
            </li>
          ))}
        </ul>
      )}
      {view.open.length > 0 && (
        <>
          <p className="aa-section">OPEN</p>
          <ul className="aa-list">
            {view.open.map((pr) => (
              <li key={pr.number} className="aa-row">
                <span className="aa-title">#{pr.number} · {pr.title}<br /><span className="muted small">{pr.meta}</span></span>
                <span className="aa-chip aa-chip-open">{pr.draft ? 'draft' : 'open'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="aa-section">NEEDS YOU</p>
      {view.needsYouStale ? (
        <p className="muted small">The Lead's action log has not been updated in the last 24 hours.</p>
      ) : view.needsYou.length === 0 ? (
        <p className="muted small">Nothing needs you right now.</p>
      ) : (
        <ul className="aa-list">
          {view.needsYou.map((item) => (
            <li key={item.at + item.text} className="aa-row">
              <span className="aa-title">{item.text}<br /><span className="muted small">{item.at}</span></span>
              <span className="aa-chip aa-chip-warn">needs you</span>
            </li>
          ))}
        </ul>
      )}
      <p className="aa-section">SPEND</p>
      <p className="aa-spend muted small">{view.spendLines.join(' · ')}</p>
    </div>
  );
}

export function AgentActivityMonitor({ nowMs }: { nowMs?: number | undefined }) {
  const [res, setRes] = useState<Fetched<AgentActivityResponse> | null>(null);
  useEffect(() => {
    let live = true;
    void getAgentActivity().then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, []);

  const view = res?.kind === 'ok' ? projectAgentActivity(res.data, nowMs ?? Date.now()) : null;
  const unavailable = res === null ? AGENT_ACTIVITY_LOADING
    : view === null ? (res.kind === 'error' && /404/.test(res.message) ? AGENT_ACTIVITY_MISSING : AGENT_ACTIVITY_FAILED)
      : null;
  return (
    <MonitorCard
      title="Agent activity"
      className="agent-activity"
      status={unavailable === null ? undefined : <p className="dash-note" role="status">{unavailable}</p>}
      summary={<p className="aa-summary">{view?.summary}</p>}
      footer={view && <p className={view.stale ? 'dash-stale aa-foot' : 'muted small aa-foot'} role="status">{view.footer}</p>}>
      {view && <Body view={view} />}
    </MonitorCard>
  );
}
