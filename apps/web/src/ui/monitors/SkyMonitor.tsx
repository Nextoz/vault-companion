// M7c2: the Daylight & sky monitor — sun and moon times are computed locally (SunCalc in packages/contracts), the
// planetary Kp index comes from NOAA SWPC, and the driest daylight window from the weather projection. The card
// fetches itself; sun and moon never need the network, so it always has something honest to show and carries no
// failure block of its own. Every word comes from the M7c1 helpers in sky.ts, never invented here.
import { useEffect, useState } from 'react';
import type { SkyResponse, WeatherResponse } from '@vault-companion/contracts';
import { getSky, getWeather, type Fetched } from '../../api.ts';
import { MonitorCard } from '../MonitorCard.tsx';
import { bestDaylightWalk, changeLabel, clock, daylightSummary, formatDuration, kpLabel, moonLabel, skySun, sunsetIn } from './sky.ts';
import './Sky.css';

// Arc geometry from the m7 mockup: a 246x162 viewBox with a half circle of radius 94 centred at (123, 138), running
// from x 29 (sunrise) to x 217 (sunset); the up/down labels sit under the baseline.
const CX = 123;
const CY = 138;
const RADIUS = 94;
const STALE_MS = 2 * 60 * 60 * 1000;

/** A point on the arc at `fraction` of sunrise..sunset (0: sunrise, 1: sunset), rounded like the mockup's own path. */
const arcX = (fraction: number): number => Math.round((CX - RADIUS * Math.cos(Math.PI * fraction)) * 10) / 10;
const arcY = (fraction: number): number => Math.round((CY - RADIUS * Math.sin(Math.PI * fraction)) * 10) / 10;

export function SkyMonitor() {
  // Two independent reads on mount; neither waits for the other, and a late answer never lands on an unmounted card.
  const [sky, setSky] = useState<Fetched<SkyResponse> | null>(null);
  const [w, setW] = useState<Fetched<WeatherResponse> | null>(null);
  useEffect(() => {
    let live = true;
    void getSky().then((result) => { if (live) setSky(result); });
    void getWeather().then((result) => { if (live) setW(result); });
    return () => { live = false; };
  }, []);
  const skyOk = sky !== null && sky.kind === 'ok' && sky.data.status === 'ok' ? sky.data : null;
  const now = new Date();
  const weather = w?.kind === 'ok' && w.data.status === 'ok' ? w.data.projection : null;
  // Sun and moon maths is local, so the card renders before any fetch answers — hence no status prop.
  const { sun, changeSeconds } = skySun(weather?.location ?? null, now);
  const normal = sun.kind === 'normal';
  const walk = weather !== null ? bestDaylightWalk(weather.models[0]!.points, sun, now.getTime()) : null;
  const kp = skyOk !== null ? kpLabel(skyOk.current) : null;
  const moon = moonLabel(now);
  const sunriseMs = normal ? Date.parse(sun.sunrise) : 0;
  const sunsetMs = normal ? Date.parse(sun.sunset) : 0;
  const dayMs = sunsetMs - sunriseMs;
  // Outside daylight the dot clamps to the arc's ends; it dims once the sun is down.
  const fraction = normal ? Math.min(Math.max((now.getTime() - sunriseMs) / dayMs, 0), 1) : 0;
  const sunDown = normal ? now.getTime() < sunriseMs || now.getTime() > sunsetMs : true;
  const walkStart = walk !== null ? (Date.parse(walk.start) - sunriseMs) / dayMs : 0;
  const walkEnd = walk !== null ? (Date.parse(walk.end) - sunriseMs) / dayMs : 0;
  const stale = skyOk !== null && now.getTime() - Date.parse(skyOk.fetchedAt) > STALE_MS;
  const updated = skyOk !== null ? ` · Updated ${clock(skyOk.fetchedAt)}` : '';
  return (
    <MonitorCard
      title="Daylight & sky"
      className="sky-monitor"
      summary={<p className="sky-summary">{daylightSummary(sun)}</p>}
      footer={
        <p className={stale ? 'dash-stale sky-updated' : 'muted small sky-updated'} role="status">
          SunCalc · NOAA SWPC{updated}
        </p>
      }
    >
      <p className="sky-big">{normal ? `${formatDuration(sun.daylightMinutes)} daylight` : daylightSummary(sun)}</p>
      {normal && <p className="muted small">{changeLabel(changeSeconds)}</p>}
      {normal && (
        <svg className="sky-arc" viewBox="0 0 246 162" aria-hidden="true">
          <path className="sky-arc-line" d={`M ${CX - RADIUS} ${CY} A ${RADIUS} ${RADIUS} 0 0 1 ${CX + RADIUS} ${CY}`} />
          {walk !== null && (
            <path
              className="sky-arc-walk"
              d={`M ${arcX(walkStart)} ${arcY(walkStart)} A ${RADIUS} ${RADIUS} 0 0 1 ${arcX(walkEnd)} ${arcY(walkEnd)}`}
            />
          )}
          <circle className={sunDown ? 'sky-sun sky-sun-set' : 'sky-sun'} cx={arcX(fraction)} cy={arcY(fraction)} r={6.5} />
          <text x={23} y={155}>up {clock(sun.sunrise)}</text>
          <text x={223} y={155} textAnchor="end">{clock(sun.sunset)} down</text>
        </svg>
      )}
      <div className="sky-row">
        <span>Best daylight walk</span>
        <span>
          {walk !== null
            ? `${clock(walk.start)}-${clock(walk.end)} · ${walk.dry ? 'dry' : `${walk.rainMm} mm`}`
            : weather !== null ? 'none left today' : 'weather unavailable'}
        </span>
      </div>
      {normal && (
        <div className="sky-row">
          <span>Golden hour</span>
          <span>{`${clock(sun.goldenHourStart)} - ${clock(sun.sunset)}`}</span>
        </div>
      )}
      <div className="sky-stats">
        <div className="sky-tile">
          <span className="sky-v">{kp !== null ? kp.value : sky === null ? 'Kp …' : 'Kp -'}</span>
          <span className="sky-k muted small">{kp !== null ? kp.level : sky === null ? 'loading' : 'unavailable'}</span>
        </div>
        <div className="sky-tile">
          <span className="sky-v">{moon.value}</span>
          <span className="sky-k muted small">{moon.sub}</span>
        </div>
        <div className="sky-tile">
          <span className="sky-v">{sunsetIn(sun, now.getTime()) ?? 'sun is down'}</span>
          <span className="sky-k muted small">sunset in</span>
        </div>
      </div>
    </MonitorCard>
  );
}
