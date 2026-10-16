// M8: the collapsed-by-default "Week runway" monitor on Boards — the next 7 Copenhagen evenings (17:00-23:00
// local) as free / busy / pick / unknown day columns with that day's weather, the scout picks and the busy
// nights below. It fetches its own read model once per mount; every wall-clock label comes from the pure
// helpers in week-runway-view.ts, so this file only draws what WeekRunwayResponse hands it.
import { useEffect, useState } from 'react';
import { WeekRunwayResponse, type WeekRunwayEvening, type WeekRunwayState } from '@vault-companion/contracts';
import { getJson, type Fetched } from '../../api.ts';
import { Icon } from '../Icon.tsx';
import { MonitorCard } from '../MonitorCard.tsx';
import { weatherGlyph } from '../weather-week.ts';
import { busyDaysLabel, dayParts, pickTime, rangeLabel, summaryLine, updatedLabel } from './week-runway-view.ts';
import './WeekRunwayMonitor.css';

/** The day column's one accessible sentence, e.g. "Fri 16: free evening, 12°" — the icon and bars stay decorative. */
const STATE_LABEL: Record<WeekRunwayState, string> = {
  free: 'free evening', busy: 'busy evening', pick: 'picked evening', unknown: 'unknown evening',
};

export function WeekRunwayMonitor() {
  const [runway, setRunway] = useState<Fetched<WeekRunwayResponse> | null>(null);
  useEffect(() => {
    let mounted = true;
    void getJson('/api/week-runway', WeekRunwayResponse).then((res) => {
      if (mounted) setRunway(res);
    });
    return () => {
      mounted = false;
    };
  }, []);
  const data = runway?.kind === 'ok' ? runway.data : null;
  return (
    <MonitorCard
      title="Week runway"
      className="week-runway"
      status={runway === null ? (
        <p className="dash-note" role="status">Loading week runway…</p>
      ) : data === null ? (
        <p className="dash-note" role="status">Week runway is unavailable.</p>
      ) : undefined}
      summary={<p className="dash-note">{data === null ? '' : summaryLine(data)}</p>}
      footer={data === null ? undefined : (
        <p className="muted small">Calendar + DMI forecast · {updatedLabel(data.now)}</p>
      )}
    >
      {data === null ? null : <WeekRunwayBody data={data} />}
    </MonitorCard>
  );
}

function WeekRunwayBody({ data }: { data: WeekRunwayResponse }) {
  // Every pick in evening order, carrying its day for the row's "{wd dt} · {pickTime}" lead line.
  const picks = data.evenings.flatMap((evening) =>
    evening.picks.map((pick) => ({ key: `${evening.day}:${pick.eventId}`, day: evening.day, pick })));
  return (
    <>
      <p className="m8-sec">{rangeLabel(data.evenings)} · WEATHER BY DAY</p>
      <div className="m8-days">
        {data.evenings.map((evening, index) => (
          <DayColumn key={evening.day} evening={evening} now={index === 0} />
        ))}
      </div>
      {data.sources.calendar !== 'ok' && (
        <p className="dash-note" role="status">Calendar could not be read; evenings show picks only.</p>
      )}
      <div className="m8-leg">
        <span><span className="m8-sw m8-swf" aria-hidden="true" />free</span>
        <span><span className="m8-sw m8-swb" aria-hidden="true" />busy</span>
        <span><span className="m8-sw m8-swe" aria-hidden="true" />scout pick</span>
      </div>
      <p className="m8-sec">PICKED BY SCOUTS</p>
      {picks.length === 0 && <p className="dash-note">No picks this week.</p>}
      {(picks.length > 0 || data.counts.busy > 0) && (
        <ul className="m8-rows">
          {picks.map(({ key, day, pick }) => {
            const parts = dayParts(day);
            return (
              <li className="m8-row" key={key}>
                <span className="m8-row-main">
                  <span className="m8-dot m8-dp" aria-hidden="true" />
                  {parts.wd} {parts.dt} · {pickTime(pick.start, pick.end)}
                  <span className="m8-sub">{pick.title}</span>
                </span>
                <span className="m8-tag">picked</span>
              </li>
            );
          })}
          {data.counts.busy > 0 && (
            <li className="m8-row">
              <span className="m8-row-main">
                <span className="m8-dot m8-db" aria-hidden="true" />
                {busyDaysLabel(data.evenings)}
                <span className="m8-sub">Busy evenings · blocked in calendar</span>
              </span>
              <span className="m8-count">{data.counts.busy}</span>
            </li>
          )}
        </ul>
      )}
      <div className="m8-sum">
        <div className="m8-kpi"><b className="m8-cg">{data.counts.free}</b><span>free evenings</span></div>
        <div className="m8-kpi"><b className="m8-cb">{data.counts.busy}</b><span>busy nights</span></div>
        <div className="m8-kpi"><b className="m8-cp">{data.counts.picked}</b><span>scout picks</span></div>
      </div>
    </>
  );
}

/** One day column: weekday, date, that day's weather icon and high, then the evening-state bar. The column's
 * `aria-label` carries the whole sentence, so the icon and the bar text stay decorative. */
function DayColumn({ evening, now }: { evening: WeekRunwayEvening; now: boolean }) {
  const { wd, dt } = dayParts(evening.day);
  const temp = evening.highTemperatureC === null ? '–' : `${Math.round(evening.highTemperatureC)}°`;
  const bar = evening.state === 'pick' ? 'm8-ev' : `m8-${evening.state}`;
  const pick = evening.state === 'pick' && evening.picks.length > 0 ? evening.picks[0]! : null;
  return (
    <div className={now ? 'm8-d m8-now' : 'm8-d'} aria-label={`${wd} ${dt}: ${STATE_LABEL[evening.state]}, ${temp}`}>
      <div className="m8-wd">{wd}</div>
      <div className="m8-dt">{dt}</div>
      <span className="m8-ic" aria-hidden="true"><Icon name={weatherGlyph(evening.weatherCode)} /></span>
      <div className="m8-t">{temp}</div>
      <div className={`m8-bar ${bar}`}>{pick === null ? null : pickTime(pick.start, pick.end)}</div>
    </div>
  );
}
