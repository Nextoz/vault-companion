// M5: the Job radar monitor. It reads the job radar file through the Worker (built from Job Search 2026 frontmatter)
// and draws the pipeline by current stage, dated follow-ups and the applications in flight. A failed read says so
// instead of showing a number; a follow-up is shown only when a note carries a date for it.
import { JobRadarResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { getJson, type Fetched } from '../../api.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import { projectJobRadar, type JobRadarView } from './job-radar.ts';
import './JobRadarMonitor.css';

export const JOB_RADAR_FAILED = 'Job radar could not be read.';
export const JOB_RADAR_MISSING = 'No job radar has been published yet.';
export const JOB_RADAR_LOADING = 'Loading job radar…';

export const getJobRadar = () => getJson('/api/monitors/job-radar', JobRadarResponse.strip());

function Body({ view }: { view: JobRadarView }) {
  return (
    <div className="jr-body">
      <p className="jr-section">PIPELINE</p>
      <ul className="jr-stages">
        {view.stages.map((s) => (
          <li key={s.stage} className="jr-stage">
            <span className="jr-label">{s.label}</span>
            <span className="jr-track" aria-hidden="true">
              <span className="jr-bar" style={{ width: s.count > 0 ? `max(2px, ${s.share * 100}%)` : '0' }} />
            </span>
            <span className="jr-count">{s.count}</span>
          </li>
        ))}
      </ul>
      {view.otherNote && <p className="jr-other muted small">{view.otherNote}</p>}
      <p className="jr-section">FOLLOW-UPS DUE</p>
      {view.followUps.length === 0 ? (
        <p className="muted small">No follow-up has a date in the notes.</p>
      ) : (
        <ul className="jr-followups">
          {view.followUps.map((f) => (
            <li key={f.title + f.due} className="jr-row">
              <span className="jr-title">{f.title}<br /><span className="muted small">{f.due}</span></span>
              <span className={f.overdue ? 'jr-chip jr-chip-overdue' : 'jr-chip jr-chip-soon'}>{f.label}</span>
            </li>
          ))}
        </ul>
      )}
      {view.inFlight.length > 0 && (
        <>
          <p className="jr-section">IN FLIGHT</p>
          <ul className="jr-flight">
            {view.inFlight.map((i) => (
              <li key={i.title} className="jr-row">
                <span className="jr-title">{i.title}</span>
                <span className="muted small jr-age">{i.ageLabel}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function JobRadarMonitor({ nowMs }: { nowMs?: number | undefined }) {
  const [res, setRes] = useState<Fetched<JobRadarResponse> | null>(null);
  useEffect(() => {
    let live = true;
    void getJobRadar().then((r) => { if (live) setRes(r); });
    return () => { live = false; };
  }, []);

  const view = res?.kind === 'ok' ? projectJobRadar(res.data, nowMs ?? Date.now()) : null;
  const unavailable = res === null ? JOB_RADAR_LOADING
    : view === null ? (res.kind === 'error' && /404/.test(res.message) ? JOB_RADAR_MISSING : JOB_RADAR_FAILED)
      : null;
  return (
    <MonitorCard
      title="Job radar"
      className="job-radar"
      status={unavailable === null ? undefined : <p className="dash-note" role="status">{unavailable}</p>}
      summary={<p className="jr-summary">{view?.summary}</p>}
      footer={view && <p className={view.stale ? 'dash-stale jr-foot' : 'muted small jr-foot'} role="status">{view.footer}</p>}>
      {view && <Body view={view} />}
    </MonitorCard>
  );
}
