// Weather UI (ADR-0033 W1). One shared projection feeds the full Dashboard inspector and the compact Today morning
// projection. Charts keep provider gaps split, never bridged. No provider calls from the browser except the explicit
// device-location POST, which is rounded before it is sent.
import {
  roundWeatherCoordinate,
  type WeatherModelSeries,
  type WeatherPoint,
  type WeatherProjection,
  type WeatherResponse,
  type WeatherRunWindow,
  type WeatherVariable,
} from '@vault-companion/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { getWeather, postWeatherLocation, type Fetched } from '../api.ts';
import './WeatherLab.css';

/** Matches the provider's bounded 15-minute cache: a projection older than this is labelled stale, never repainted fresh. */
export const WEATHER_STALE_MS = 15 * 60_000;

const VARIABLES: readonly { value: WeatherVariable; label: string; unit: string }[] = [
  { value: 'temperature', label: 'Temperature', unit: '°C' },
  { value: 'rain', label: 'Rain', unit: 'mm' },
  { value: 'wind', label: 'Wind', unit: 'm/s' },
];

const localTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Copenhagen', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export const formatWeatherTime = (iso: string): string => localTime.format(new Date(iso));
const at = (iso: string): number => Date.parse(iso);

export function weatherFresh(projection: WeatherProjection, nowMs: number): boolean {
  const newest = projection.models.map((series) => at(series.retrievedAt)).sort((a, b) => a - b)[0];
  return newest !== undefined && nowMs - newest <= WEATHER_STALE_MS;
}

/** Indices grouped where the provider left an hourly bucket out: each group is drawn as its own line, never joined. */
export function weatherSegments(points: readonly WeatherPoint[], variable?: WeatherVariable): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  points.forEach((point, index) => {
    if (variable && valueAt(point, variable) === null) {
      if (current.length) groups.push(current);
      current = [];
      return;
    }
    if (current.length > 0) {
      const previous = points[current[current.length - 1]!]!;
      if (at(point.time) - at(previous.time) > 3_600_000) {
        groups.push(current);
        current = [];
      }
    }
    current.push(index);
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

const valueAt = (point: WeatherPoint | undefined, variable: WeatherVariable): number | null => {
  if (!point) return null;
  if (variable === 'temperature') return point.temperatureC;
  if (variable === 'rain') return point.rainMm;
  return point.windMs;
};

const formatValue = (value: number | null, variable: WeatherVariable): string =>
  value === null ? 'no data' : `${value.toFixed(1)} ${VARIABLES.find((v) => v.value === variable)!.unit}`;

/** The honest compact morning summary, used both collapsed on Today and in the Dashboard card header area. */
export function runWindowSummary(window: WeatherRunWindow | null): string {
  if (!window) return 'No two-hour daytime window could be chosen from the forecast.';
  const agreement = window.agreement === 'two-models' ? 'Two models cover this window' : 'One model covers this window';
  const rain = window.rainMm === null
    ? 'rain unavailable'
    : `rain ${window.rainMm.toFixed(1)} mm (models ${window.rainRangeMm.min.toFixed(1)}–${window.rainRangeMm.max.toFixed(1)})`;
  const temp = `temp ${window.temperatureRangeC.min.toFixed(0)}–${window.temperatureRangeC.max.toFixed(0)}°C`;
  const wind = `wind ${window.windRangeMs.min.toFixed(0)}–${window.windRangeMs.max.toFixed(0)} m/s`;
  return `${formatWeatherTime(window.start)}–${formatWeatherTime(window.end)}: ${agreement}; lowest-rain window ${rain}; ${temp}; ${wind}.`;
}

interface ChartProps {
  seriesList: readonly WeatherModelSeries[];
  variable: WeatherVariable;
  active: number;
  onInspect: (index: number) => void;
}

function WeatherChart({ seriesList, variable, active, onInspect }: ChartProps) {
  const timeline = seriesList[0]!;
  const points = timeline.points;
  const { tMin, tMax, valueMin, valueMax } = useMemo(() => {
    const times = seriesList.flatMap((series) => series.points.map((p) => at(p.time)));
    const values = seriesList.flatMap((series) => series.points.map((p) => valueAt(p, variable)).filter((v): v is number => v !== null));
    return {
      tMin: times.length ? Math.min(...times) : 0,
      tMax: times.length ? Math.max(...times) : 1,
      valueMin: values.length ? Math.min(...values) : 0,
      valueMax: values.length ? Math.max(...values) : 1,
    };
  }, [seriesList, variable]);
  const W = 320;
  const H = 140;
  const PAD = 8;
  const timeSpan = tMax - tMin || 1;
  const valueSpan = valueMax - valueMin || 1;
  const x = (time: number) => PAD + ((time - tMin) / timeSpan) * (W - 2 * PAD);
  const y = (value: number) => H - PAD - ((value - valueMin) / valueSpan) * (H - 2 * PAD);
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(rect.width / W, rect.height / H);
    if (scale <= 0) return;
    const plotX = (event.clientX - rect.left - (rect.width - W * scale) / 2) / scale;
    const ratio = Math.min(1, Math.max(0, (plotX - PAD) / (W - 2 * PAD)));
    const pickedTime = tMin + ratio * timeSpan;
    let nearest = 0;
    let distance = Infinity;
    points.forEach((point, index) => {
      const next = Math.abs(at(point.time) - pickedTime);
      if (next < distance) {
        distance = next;
        nearest = index;
      }
    });
    onInspect(nearest);
  };
  const activeTime = points[Math.min(active, points.length - 1)]?.time;
  const hasData = seriesList.some((series) => series.points.some((p) => valueAt(p, variable) !== null));
  return (
    <figure className="weather-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="weather-svg" role="img" aria-label={`${VARIABLES.find((v) => v.value === variable)!.label}: ${points.length} points`} onPointerDown={pick} onPointerMove={(e) => { if (e.buttons) pick(e); }}>
        {hasData && seriesList.map((series, seriesIndex) => {
          const segments = weatherSegments(series.points, variable);
          return (
            <g key={series.model} className={seriesIndex === 0 ? 'weather-line-primary' : 'weather-line-comparison'}>
              {segments.map((segment, index) => {
                const values = segment.map((i) => ({ x: x(at(series.points[i]!.time)), y: valueAt(series.points[i]!, variable) })).filter((v) => v.y !== null) as { x: number; y: number }[];
                return values.length > 1
                  ? <polyline key={index} points={values.map((v) => `${v.x},${v.y}`).join(' ')} />
                  : values.map((v) => <circle key={index} cx={v.x} cy={v.y} r={2} />);
              })}
            </g>
          );
        })}
        {activeTime && <circle className="weather-cursor" cx={x(at(activeTime))} cy={y(valueAt(points[Math.min(active, points.length - 1)]!, variable) ?? valueMin)} r={4} />}
      </svg>
      <input
        type="range"
        className="weather-slider"
        min={0}
        max={Math.max(0, points.length - 1)}
        step={1}
        value={Math.min(active, Math.max(0, points.length - 1))}
        onInput={(e) => onInspect(Number(e.currentTarget.value))}
        aria-label="Inspect forecast time"
      />
      <figcaption className="weather-readout" aria-live="polite">
        {points.length > 0
          ? <>
              <time dateTime={points[Math.min(active, points.length - 1)]!.time}>{formatWeatherTime(points[Math.min(active, points.length - 1)]!.time)}</time>
              {' · '}
              {seriesList.map((series, index) => (
                <span key={series.model} className={index === 0 ? 'weather-readout-primary' : 'weather-readout-comparison'}>
                  {series.label}: {formatValue(valueAt(series.points.find((p) => p.time === activeTime), variable), variable)}
                  {index < seriesList.length - 1 ? ' · ' : ''}
                </span>
              ))}
            </>
          : 'No points to inspect'}
      </figcaption>
    </figure>
  );
}

export interface WeatherLabProps {
  projection: WeatherProjection;
  accountKey?: string | null;
  onUsePreciseLocation?: () => void;
  locationBusy?: boolean;
  locationDenied?: string | null;
}

export function WeatherLab({ projection, accountKey, onUsePreciseLocation, locationBusy, locationDenied }: WeatherLabProps) {
  const [variable, setVariable] = useState<WeatherVariable>('rain');
  const [showComparison, setShowComparison] = useState(true);
  const [active, setActive] = useState(projection.models[0]!.points.length - 1);
  const seriesKey = projection.models.map((m) => `${m.model}:${m.points.length}`).join('|');
  useEffect(() => { setActive(projection.models[0]!.points.length - 1); }, [seriesKey]);
  const visible = useMemo(() => {
    const primary = projection.models[0];
    const comparison = projection.models[1];
    return primary && comparison && showComparison ? [primary, comparison] : primary ? [primary] : [];
  }, [projection.models, showComparison]);
  // Freshness is measured against the server `now` in the projection, never the phone clock.
  const stale = !weatherFresh(projection, at(projection.now));
  const headingId = useId();
  return (
    <section className="weather-lab" aria-labelledby={headingId}>
      <h2 id={headingId}>Weather</h2>
      <p className="muted small">{projection.location.label} · {projection.partialError === 'one-model-unavailable' ? 'one model unavailable' : `${projection.models.length} models`}</p>
      <p className="muted small">
        {projection.attribution} <a href={projection.termsUrl} target="_blank" rel="noreferrer">Terms</a>
      </p>
      {stale && <p className="weather-stale" role="status">Not refreshed — showing the last successful forecast.</p>}
      <div className="weather-source-list">
        {projection.models.map((series) => (
          <p key={series.model} className="muted small">
            {series.label} ({series.resolutionKm} km) · {series.points.length}/{series.expectedPoints} points · {series.missingIntervals} gaps · retrieved <time dateTime={series.retrievedAt}>{formatWeatherTime(series.retrievedAt)}</time> · <a href={series.sourceUrl} target="_blank" rel="noreferrer">Source</a>
          </p>
        ))}
      </div>
      {projection.runWindow && (
        <div className="weather-window" role="status">
          <strong>{runWindowSummary(projection.runWindow)}</strong>
          <p className="muted small">{projection.runWindow.note}</p>
        </div>
      )}
      {!projection.runWindow && <p className="muted small">No two-hour daytime window could be chosen from the forecast.</p>}

      <div className="segmented weather-controls" role="group" aria-label="Weather variable">
        {VARIABLES.map((option) => (
          <button key={option.value} type="button" aria-pressed={variable === option.value} onClick={() => setVariable(option.value)}>{option.label}</button>
        ))}
      </div>
      {projection.models[1] && (
        <button type="button" className="weather-compare" aria-pressed={showComparison} onClick={() => setShowComparison((value) => !value)}>
          {showComparison ? `Hide ${projection.models[1].label}` : `Compare ${projection.models[1].label}`}
        </button>
      )}
      {visible.length > 0
        ? <WeatherChart seriesList={visible} variable={variable} active={active} onInspect={setActive} />
        : <p className="weather-note" role="status">No model series to chart.</p>}
      {onUsePreciseLocation && accountKey && (
        <div className="weather-location">
          <button type="button" onClick={onUsePreciseLocation} disabled={locationBusy}>
            {locationBusy ? 'Finding device location…' : 'Use my device location'}
          </button>
          {locationDenied && <p className="weather-note" role="status">{locationDenied}</p>}
        </div>
      )}
    </section>
  );
}

export interface WeatherMorningProps {
  refreshKey: number | null;
  accountKey: string | null;
  blocked?: boolean;
}

export function WeatherMorning({ refreshKey, accountKey, blocked = false }: WeatherMorningProps) {
  const [result, setResult] = useState<Fetched<WeatherResponse> | null>(null);
  const [open, setOpen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationDenied, setLocationDenied] = useState<string | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    let live = true;
    if (!accountKey || blocked || document.visibilityState === 'hidden' || !navigator.onLine) return;
    setLocationBusy(false);
    void getWeather().then((value) => { if (live && gen === genRef.current) setResult(value); });
    return () => { live = false; ++genRef.current; };
  }, [refreshKey, retryKey, accountKey, blocked]);

  const usePreciseLocation = useCallback(() => {
    if (!accountKey || blocked || document.visibilityState === 'hidden' || !navigator.onLine || !('geolocation' in navigator)) {
      setLocationDenied('Device location is unavailable — using the coarse Copenhagen fallback.');
      return;
    }
    setLocationBusy(true);
    setLocationDenied(null);
    const gen = ++genRef.current;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (gen !== genRef.current || document.visibilityState === 'hidden' || !navigator.onLine) return;
        const request = { latitude: roundWeatherCoordinate(position.coords.latitude), longitude: roundWeatherCoordinate(position.coords.longitude) };
        void postWeatherLocation(request, accountKey).then((value) => {
          if (gen !== genRef.current) return;
          setLocationBusy(false);
          setResult(value);
        });
      },
      () => {
        if (gen !== genRef.current) return;
        setLocationBusy(false);
        setLocationDenied('Location permission denied — using the coarse Copenhagen fallback.');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 },
    );
  }, [accountKey, blocked]);

  if (!accountKey || blocked) return null;

  if (result?.kind !== 'ok') {
    if (result?.kind === 'offline' || result?.kind === 'error' || result?.kind === 'signed-out') {
      return (
        <section className="group weather-morning" aria-label="This morning weather">
          <h2>Weather</h2>
          <p className="weather-note" role="status">{result.kind === 'offline' ? 'Weather is unavailable offline.' : 'Weather could not be loaded.'}</p>
          {result.kind !== 'signed-out' && <button type="button" className="link" onClick={() => setRetryKey((n) => n + 1)}>Retry weather</button>}
        </section>
      );
    }
    return null;
  }
  if (result.data.status !== 'ok') {
    return (
      <section className="group weather-morning" aria-label="This morning weather">
        <h2>Weather</h2>
        <p className="weather-note" role="status">{result.data.message}</p>
        <button type="button" className="link" onClick={() => setRetryKey((n) => n + 1)}>Retry weather</button>
      </section>
    );
  }
  const projection = result.data.projection;
  return (
    <section className="group weather-morning" aria-label="This morning weather">
      <h2>
        <button type="button" className="link group-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Weather</button>
      </h2>
      <p className="muted small" data-testid="weather-morning-summary">{runWindowSummary(projection.runWindow)}</p>
      {open && (
        <WeatherLab projection={projection} accountKey={accountKey} onUsePreciseLocation={usePreciseLocation} locationBusy={locationBusy} locationDenied={locationDenied} />
      )}
    </section>
  );
}
