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
  type WeatherWeekDay,
  type WeatherVariable,
} from '@vault-companion/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { getWeather, postWeatherLocation, type Fetched } from '../api.ts';
import {
  bestRunDay,
  bestRunSummary,
  dayHours,
  dayLabel,
  dayRunSummary,
  dayScale,
  localDate,
  modelCountLabel,
  modelDayHours,
  rainBar,
  rainLabel,
  rainSummary,
  rowDayLabel,
  runWindowHours,
  scalePercent,
  weekBar,
  weekBarLabel,
  weekFootnote,
  weekRainMode,
  weekScale,
  weatherCodeLabel,
  weatherGlyph,
  type DayHour,
} from './weather-week.ts';
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

/** Advance server time with monotonic elapsed time, without fetching or trusting the phone wall clock. */
function useWeatherNow(serverNow: string | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const started = performance.now();
    const timer = setInterval(() => setElapsed(performance.now() - started), 30_000);
    return () => clearInterval(timer);
  }, [serverNow]);
  return serverNow ? at(serverNow) + elapsed : 0;
}

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
  const fillId = `weather-fill-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <figure className="weather-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="weather-svg" role="img" aria-label={`${VARIABLES.find((v) => v.value === variable)!.label}: ${points.length} points`} onPointerDown={pick} onPointerMove={(e) => { if (e.buttons) pick(e); }}>
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="weather-fill-top" />
            <stop offset="100%" className="weather-fill-bottom" />
          </linearGradient>
        </defs>
        {hasData && seriesList.map((series, seriesIndex) => {
          const segments = weatherSegments(series.points, variable);
          return (
            <g key={series.model} className={seriesIndex === 0 ? 'weather-line-primary' : 'weather-line-comparison'}>
              {segments.map((segment, index) => {
                const values = segment
                  .map((i) => ({ x: x(at(series.points[i]!.time)), value: valueAt(series.points[i]!, variable) }))
                  .filter((v): v is { x: number; value: number } => v.value !== null)
                  .map((v) => ({ x: v.x, y: y(v.value) }));
                if (values.length < 2) return values.map((v) => <circle key={index} cx={v.x} cy={v.y} r={2} />);
                const line = values.map((v) => `${v.x},${v.y}`).join(' ');
                return (
                  <g key={index}>
                    {seriesIndex === 0 && <path className="weather-area" fill={`url(#${fillId})`} d={`M${values[0]!.x},${H - PAD} L${line.replaceAll(' ', ' L')} L${values[values.length - 1]!.x},${H - PAD} Z`} />}
                    <polyline points={line} />
                  </g>
                );
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

interface WeekRowsProps {
  week: readonly WeatherWeekDay[];
  today: string | null;
  onOpen: (day: string) => void;
  registerRow: (day: string, element: HTMLButtonElement | null) => void;
}

const degrees = (value: number | null): string => (value === null ? '—' : `${Math.round(value)}°`);

/** W3: one compact tappable row per day on the shared temperature scale, then the best-day box right under the rows. */
function WeatherWeekRows({ week, today, onOpen, registerRow }: WeekRowsProps) {
  const scale = useMemo(() => weekScale(week), [week]);
  const bestDay = useMemo(() => bestRunDay(week), [week]);
  const best = useMemo(() => bestRunSummary(week), [week]);
  const rainMode = useMemo(() => weekRainMode(week), [week]);
  const footnote = weekFootnote(week, today);
  return (
    <section className="weather-week" aria-label="Seven-day forecast">
      <ul className={`weather-week-list weather-week-rain-${rainMode}`}>
        {week.map((day) => {
          const bar = weekBar(day, scale);
          const isBest = bestDay?.day === day.day;
          return (
            <li key={day.day}>
              <button
                type="button"
                className={`weather-week-row${isBest ? ' weather-week-row-best' : ''}`}
                ref={(element) => registerRow(day.day, element)}
                onClick={() => onOpen(day.day)}
                aria-label={`${dayLabel(day.day)}: ${weatherCodeLabel(day.weatherCode)}, ${weekBarLabel(day)}, rain ${rainLabel(day, rainMode)}${day.models === 1 ? `, ${modelCountLabel(day)}` : ''}${day.partial ? ', partial day' : ''}${isBest ? ', best run day' : ''}`}
              >
                <span className="weather-week-day">{rowDayLabel(day.day, today)}</span>
                <span className="weather-week-icon" aria-hidden="true">{weatherGlyph(day.weatherCode)}</span>
                <span className="weather-week-low">{degrees(day.lowTemperatureC)}</span>
                <span className="weather-week-track" aria-hidden="true">
                  {bar && <span className={`weather-week-fill${day.models === 1 ? ' weather-week-fill-single' : ''}`} style={{ left: `${bar.left}%`, width: `${bar.width}%` }} />}
                </span>
                <span className="weather-week-high">{degrees(day.highTemperatureC)}</span>
                <span className="weather-week-rain">{rainLabel(day, rainMode)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {best
        ? <p className="weather-week-best" role="status">{best}</p>
        : <p className="muted small">No complete run window in the next days.</p>}
      <p className="weather-week-hint">Tap a day for its hourly forecast{footnote ? ` · ${footnote}` : ''}</p>
    </section>
  );
}

interface DayProps {
  day: WeatherWeekDay;
  models: readonly WeatherModelSeries[];
  onBack: () => void;
}

/** Waking-day ticks, as in the W1 mockup: the axis labels and the wind row share them. */
const AXIS_HOURS = [6, 10, 14, 18, 22] as const;

/** First model's short name ("DMI", "ECMWF") for the line legend. */
const shortModel = (series: WeatherModelSeries): string => series.label.split(' ')[0] ?? series.label;

/** The wind sample at a tick hour, or the nearest hour within one either side; null when the provider has none. */
function windAt(hours: readonly DayHour[], hour: number): DayHour | null {
  for (const candidate of [hour, hour + 1, hour - 1]) {
    const found = hours.find((entry) => entry.hour === candidate && entry.windMs !== null && entry.windDirectionDeg !== null);
    if (found) return found;
  }
  return null;
}

/** W1: the 24-hour day meteogram: rain bars, one temperature line per model, the run-window band and a wind row. */
function WeatherDayMeteogram({ day, models, onBack }: DayProps) {
  const perModel = useMemo(() => models.map((series) => ({ series, hours: modelDayHours(series, day.day) })), [models, day.day]);
  const merged = useMemo(() => dayHours(models, day.day), [models, day.day]);
  const scale = useMemo(() => dayScale(perModel.map((model) => model.hours)), [perModel]);
  const maxRain = useMemo(() => Math.max(0, ...merged.map((hour) => hour.rainMm ?? 0)), [merged]);
  const windowHours = useMemo(() => runWindowHours(day.runWindow), [day.runWindow]);
  const covered = perModel.filter((model) => model.hours.length > 0);
  const winds = merged.map((hour) => hour.windMs).filter((value): value is number => value !== null);
  const directions = merged.map((hour) => hour.windDirectionDeg).filter((value): value is number => value !== null);
  const windNote = winds.length > 0
    ? `Wind ${Math.min(...winds).toFixed(0)}-${Math.max(...winds).toFixed(0)} m/s`
    : 'Wind unavailable';
  // Hourly temperatures from the same merged data the lines are drawn from, so the readout matches the chart.
  const hourTemps = merged
    .filter((hour) => hour.temperatureC !== null)
    .map((hour) => `${String(hour.hour).padStart(2, '0')}:00 ${Math.round(hour.temperatureC as number)}°C`)
    .join(', ');
  const warmest = merged.reduce<DayHour | null>((top, hour) => (
    hour.temperatureC !== null && (top === null || hour.temperatureC > (top.temperatureC as number)) ? hour : top
  ), null);
  const hourly = merged.map((hour) => hour.temperatureC).filter((value): value is number => value !== null);
  // The headline comes from the hours the chart draws, so "high" and the peak label never disagree.
  const high = hourly.length > 0 ? Math.max(...hourly) : day.highTemperatureC;
  const low = hourly.length > 0 ? Math.min(...hourly) : day.lowTemperatureC;
  const legend = covered.length > 1
    ? `Solid ${shortModel(covered[0]!.series)} · dashed ${shortModel(covered[1]!.series)}`
    : covered.length === 1 ? `${shortModel(covered[0]!.series)} only` : null;

  const W = 340;
  const H = 164;
  const padX = 10;
  const plotTop = 16;
  const plotBottom = 112;
  const rainMax = 40;
  const axisY = 126;
  const arrowY = 142;
  const speedY = 158;
  const colW = (W - 2 * padX) / 24;
  const xc = (hour: number): number => padX + (hour + 0.5) * colW;
  const y = (value: number): number => plotBottom - (scalePercent(value, scale) / 100) * (plotBottom - plotTop);

  const segments = (hours: readonly DayHour[]): { x: number; y: number }[][] => {
    const points = new Map(hours.filter((hour) => hour.temperatureC !== null).map((hour) => [hour.hour, hour] as const));
    const groups: { x: number; y: number }[][] = [];
    let current: { x: number; y: number }[] = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const point = points.get(hour);
      if (!point) {
        if (current.length > 0) groups.push(current);
        current = [];
        continue;
      }
      current.push({ x: xc(hour), y: y(point.temperatureC as number) });
    }
    if (current.length > 0) groups.push(current);
    return groups;
  };

  return (
    <section className="weather-day" aria-label={`${dayLabel(day.day)} forecast`}>
      <div className="weather-day-head">
        <button type="button" className="weather-back" onClick={onBack}>Back</button>
        <h3 className="weather-day-title">{dayLabel(day.day)}</h3>
      </div>
      <div className="weather-day-hero">
        <p className="weather-day-temp">
          {degrees(high)}
          <span className="weather-day-low"> / {degrees(low)}</span>
        </p>
        <p className="weather-day-summary" data-testid="weather-day-summary">{rainSummary(merged)}</p>
      </div>
      {day.partial && <p className="weather-day-note" role="status">Partial day: only the hours forecast so far are shown.</p>}
      {covered.length < models.length && (
        <p className="weather-day-note" role="status">One model unavailable: showing {covered.map((model) => model.series.label).join(', ') || 'no model'} only.</p>
      )}
      {merged.length === 0
        ? <p className="weather-note" role="status">No hourly detail for this day.</p>
        : (
          <figure className="weather-day-chart">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="weather-day-svg"
              role="img"
              aria-label={`${dayLabel(day.day)} hourly forecast: ${rainSummary(merged)}; ${windNote}${directions.length > 0 ? `, directions ${Math.min(...directions)}-${Math.max(...directions)} degrees` : ''}${hourTemps ? `; hourly temperature ${hourTemps}` : '; hourly temperature unavailable'}`}
            >
              {windowHours.length > 0 && (
                <rect
                  className="weather-day-window"
                  x={padX + Math.min(...windowHours) * colW}
                  y={plotTop}
                  width={(Math.max(...windowHours) - Math.min(...windowHours) + 1) * colW}
                  height={plotBottom - plotTop}
                />
              )}
              {AXIS_HOURS.map((hour) => (
                <line key={hour} className="weather-day-grid" x1={xc(hour)} y1={plotTop} x2={xc(hour)} y2={plotBottom} />
              ))}
              <line className="weather-day-baseline" x1={padX} y1={plotBottom} x2={W - padX} y2={plotBottom} />
              {merged.filter((hour) => hour.rainMm !== null && hour.rainMm > 0).map((hour) => {
                const height = (rainBar(hour, maxRain) / 100) * rainMax;
                return <rect key={hour.hour} className="weather-day-rain" x={xc(hour.hour) - colW * 0.32} y={plotBottom - height} width={colW * 0.64} height={height} />;
              })}
              {perModel.map((model, index) => segments(model.hours).map((segment, segmentIndex) => (
                segment.length < 2
                  ? <circle key={`${model.series.model}-${segmentIndex}`} className={index === 0 ? 'weather-day-temp-primary' : 'weather-day-temp-comparison'} cx={segment[0]!.x} cy={segment[0]!.y} r={2.5} />
                  : <polyline key={`${model.series.model}-${segmentIndex}`} className={index === 0 ? 'weather-day-temp-primary' : 'weather-day-temp-comparison'} points={segment.map((point) => `${point.x},${point.y}`).join(' ')} />
              )))}
              {warmest && (
                <text className="weather-day-peak" x={xc(warmest.hour)} y={y(warmest.temperatureC as number) - 5} textAnchor="middle">
                  {degrees(warmest.temperatureC)}
                </text>
              )}
              {AXIS_HOURS.map((hour) => (
                <text key={hour} className="weather-day-axis" x={xc(hour)} y={axisY} textAnchor="middle">{String(hour).padStart(2, '0')}</text>
              ))}
              {AXIS_HOURS.map((hour) => {
                const wind = windAt(merged, hour);
                if (!wind) return null;
                // Provider direction is where the wind comes FROM; the arrow points where it blows.
                return (
                  <g key={`wind-${hour}`} className="weather-day-wind">
                    <text x={xc(hour)} y={arrowY} textAnchor="middle" dominantBaseline="middle" transform={`rotate(${wind.windDirectionDeg! + 180} ${xc(hour)} ${arrowY})`}>↑</text>
                    <text className="weather-day-wind-speed" x={xc(hour)} y={speedY} textAnchor="middle">{Math.round(wind.windMs!)}</text>
                  </g>
                );
              })}
            </svg>
            <p className={`weather-day-run${day.runWindow ? '' : ' weather-day-run-none'}`} role="status">{dayRunSummary(day.runWindow)}</p>
            <figcaption className="weather-readout">
              {legend && <span className="weather-day-legend">{legend} · wind m/s</span>}
              {/* The numbers behind the lines stay one tap away; the W1 mockup shows only the chart. */}
              <details className="weather-day-hours">
                <summary>Hourly temperatures</summary>
                <span className="weather-day-temps" data-testid="weather-day-temps">Temperatures: {hourTemps || 'unavailable'}</span>
              </details>
            </figcaption>
          </figure>
        )}
    </section>
  );
}

/** Swap between the week rows and one day's meteogram, returning focus to the tapped row after Back. */
function WeatherWeekPanel({ projection }: { projection: WeatherProjection }) {
  const week = projection.week ?? [];
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [returnFocus, setReturnFocus] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const registerRow = useCallback((day: string, element: HTMLButtonElement | null) => {
    if (element) rows.current.set(day, element);
    else rows.current.delete(day);
  }, []);
  useEffect(() => {
    if (openDay === null && returnFocus) {
      rows.current.get(returnFocus)?.focus();
      setReturnFocus(null);
    }
  }, [openDay, returnFocus]);
  const day = openDay ? week.find((entry) => entry.day === openDay) : undefined;
  if (day) return <WeatherDayMeteogram day={day} models={projection.models} onBack={() => { setReturnFocus(day.day); setOpenDay(null); }} />;
  return <WeatherWeekRows week={week} today={projection.now ? localDate(projection.now) : null} onOpen={setOpenDay} registerRow={registerRow} />;
}

/** One provenance line per model: resolution, coverage, gaps, retrieval time and source link. */
function WeatherSourceList({ models }: { models: readonly WeatherModelSeries[] }) {
  return (
    <div className="weather-source-list">
      {models.map((series) => (
        <p key={series.model} className="muted small">
          {series.label} ({series.resolutionKm} km) · {series.points.length}/{series.expectedPoints} points · {series.missingIntervals} gaps · retrieved <time dateTime={series.retrievedAt}>{formatWeatherTime(series.retrievedAt)}</time> · <a href={series.sourceUrl} target="_blank" rel="noreferrer">Source</a>
        </p>
      ))}
    </div>
  );
}

/** Location, attribution, per-model provenance and the run-window rule: kept complete, but one tap away. */
function WeatherSources({ projection }: { projection: WeatherProjection }) {
  return (
    <details className="weather-sources">
      <summary>Sources · Open-Meteo, CC-BY 4.0</summary>
      <p className="muted small">{projection.location.label} · {projection.models.length} {projection.models.length === 1 ? 'model' : 'models'}</p>
      <p className="muted small">
        {projection.attribution} <a href={projection.termsUrl} target="_blank" rel="noreferrer">Terms</a>
      </p>
      <WeatherSourceList models={projection.models} />
      {projection.runWindow && <p className="muted small">{runWindowSummary(projection.runWindow)} {projection.runWindow.note}</p>}
    </details>
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
  const stale = !weatherFresh(projection, useWeatherNow(projection.now));
  const headingId = useId();
  const hasWeek = (projection.week?.length ?? 0) > 0;
  return (
    <section className="weather-lab" aria-labelledby={headingId}>
      <h2 id={headingId}>Weather</h2>
      {hasWeek
        // WX1 (W3 mockup): the week starts at the top; provenance sits behind the Sources toggle under it.
        ? <>
            {stale && <p className="weather-stale" role="status">Not refreshed — showing the last successful forecast.</p>}
            {projection.partialError === 'one-model-unavailable' && <p className="weather-stale" role="status">One model unavailable: the week shows one model only.</p>}
            <WeatherWeekPanel projection={projection} />
            <WeatherSources projection={projection} />
          </>
        : <>
            <p className="muted small">{projection.location.label} · {projection.partialError === 'one-model-unavailable' ? 'one model unavailable' : `${projection.models.length} models`}</p>
            <p className="muted small">
              {projection.attribution} <a href={projection.termsUrl} target="_blank" rel="noreferrer">Terms</a>
            </p>
            {stale && <p className="weather-stale" role="status">Not refreshed — showing the last successful forecast.</p>}
            <WeatherSourceList models={projection.models} />
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
          </>}
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
  const serverNow = result?.kind === 'ok' && result.data.status === 'ok' ? result.data.projection.now : null;
  const currentNow = useWeatherNow(serverNow);

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
        if (gen !== genRef.current) return;
        if (document.visibilityState === 'hidden' || !navigator.onLine) {
          setLocationBusy(false);
          setLocationDenied('Device location was not used while hidden or offline — using the coarse Copenhagen fallback.');
          return;
        }
        const request = { latitude: roundWeatherCoordinate(position.coords.latitude), longitude: roundWeatherCoordinate(position.coords.longitude) };
        void postWeatherLocation(request, accountKey).then((value) => {
          if (gen !== genRef.current) return;
          setLocationBusy(false);
          setResult(value);
        });
      },
      (error) => {
        if (gen !== genRef.current) return;
        setLocationBusy(false);
        setLocationDenied(error.code === 1
          ? 'Location permission denied — using the coarse Copenhagen fallback.'
          : 'Device location could not be obtained — using the coarse Copenhagen fallback.');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 },
    );
  }, [accountKey, blocked]);

  if (!accountKey || blocked) return null;

  if (result?.kind !== 'ok') {
    if (result?.kind === 'offline' || result?.kind === 'error' || result?.kind === 'signed-out') {
      return (
        <section className="weather-morning" aria-label="This morning weather">
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
      <section className="weather-morning" aria-label="This morning weather">
        <h2>Weather</h2>
        <p className="weather-note" role="status">{result.data.message}</p>
        <button type="button" className="link" onClick={() => setRetryKey((n) => n + 1)}>Retry weather</button>
      </section>
    );
  }
  const projection = result.data.projection;
  return (
    <section className="weather-morning" aria-label="This morning weather">
      <h2>
        <button type="button" className="link group-toggle" aria-label="Weather" aria-expanded={open} onClick={() => setOpen((value) => !value)}>Weather</button>
      </h2>
      <p className="muted small" data-testid="weather-morning-summary">{runWindowSummary(projection.runWindow)}</p>
      {!weatherFresh(projection, currentNow) && <p role="status">Not refreshed — showing the last successful forecast.</p>}
      {open && (
        <WeatherLab projection={projection} accountKey={accountKey} onUsePreciseLocation={usePreciseLocation} locationBusy={locationBusy} locationDenied={locationDenied} />
      )}
    </section>
  );
}
