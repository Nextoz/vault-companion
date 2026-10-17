// Pure parsing and projection for the barometer monitor. No fetch here: barometer-provider.ts owns the network.
// DMI metObs answers with one GeoJSON feature per observation; Open-Meteo `dmi_seamless` time columns carry no
// zone suffix and are parsed as UTC. Fresh station measurements win; the model only stands in when all are stale.
import {
  BAROMETER_LATITUDE,
  BAROMETER_LONGITUDE,
  BAROMETER_MAX_AGE_MS,
  BAROMETER_PLACE,
  BAROMETER_REASON_NOTES,
  BAROMETER_STEADY_HPA,
  type BarometerResponse,
  barometerZone,
} from '@vault-companion/contracts';

export interface DmiObs {
  /** ISO instant with `Z`. */
  readonly timeUtc: string;
  readonly hPa: number;
}

export interface DmiStation {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** Newest first. */
  readonly obs: readonly DmiObs[];
}

export interface ModelSeries {
  readonly currentTimeUtc: string;
  readonly currentHPa: number;
  /** Ascending. */
  readonly hourly: readonly DmiObs[];
}

const THREE_HOURS_MS = 3 * 3_600_000;
/** An obs more than this far into the future is not fresh either (clock-skew guard). */
const FUTURE_TOLERANCE_MS = 10 * 60_000;
/** A station history row must lie within +/- 5 minutes of the three-hours-ago target. */
const STATION_HISTORY_WINDOW_MS = 5 * 60_000;
const EARTH_RADIUS_KM = 6371.0088;
/** Below this distance IDW returns the point's own value instead of dividing by ~0. */
const COINCIDENT_KM = 0.001;
/** Open-Meteo UTC minute column: `YYYY-MM-DDTHH:MM`, no zone suffix. */
const MINUTE_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TO_RADIANS = Math.PI / 180;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** ISO instant ending in `Z` that `Date.parse` accepts, as ms; null otherwise. */
function isoZMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.endsWith('Z')) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** An Open-Meteo UTC minute column value, as ms; null otherwise. */
function minuteMs(value: unknown): number | null {
  if (typeof value !== 'string' || !MINUTE_UTC.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** GeoJSON Point coordinates `[lon, lat]` as finite numbers, or null. */
function lonLat(geometry: unknown): { lat: number; lon: number } | null {
  if (typeof geometry !== 'object' || geometry === null) return null;
  const coordinates = (geometry as Record<string, unknown>).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;
  const [lon, lat] = coordinates;
  if (typeof lon !== 'number' || !Number.isFinite(lon)) return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return null;
  return { lat, lon };
}

/** Freshness shared by a station's newest obs and the model's current time: at most BAROMETER_MAX_AGE_MS old, and
 *  no more than 10 minutes into the future. */
function isFresh(ms: number, nowMs: number): boolean {
  return ms >= nowMs - BAROMETER_MAX_AGE_MS && ms <= nowMs + FUTURE_TOLERANCE_MS;
}

/** The obs closest to `targetMs` within +/- STATION_HISTORY_WINDOW_MS (its hPa), or null when the station has none. */
function obsNear(obs: readonly DmiObs[], targetMs: number): number | null {
  let best: { distanceMs: number; hPa: number } | null = null;
  for (const candidate of obs) {
    const ms = Date.parse(candidate.timeUtc);
    if (!Number.isFinite(ms)) continue;
    const distanceMs = Math.abs(ms - targetMs);
    if (distanceMs > STATION_HISTORY_WINDOW_MS) continue;
    if (best === null || distanceMs < best.distanceMs) best = { distanceMs, hPa: candidate.hPa };
  }
  return best === null ? null : best.hPa;
}

/** The model's pressure at `targetMs`: the exact hourly row, or linear between the two rows that bracket it; null
 *  when the target is not bracketed. */
function interpolateHourly(hourly: readonly DmiObs[], targetMs: number): number | null {
  let before: { ms: number; hPa: number } | null = null;
  let after: { ms: number; hPa: number } | null = null;
  for (const obs of hourly) {
    const ms = Date.parse(obs.timeUtc);
    if (!Number.isFinite(ms)) continue;
    if (ms === targetMs) return obs.hPa;
    if (ms < targetMs && (before === null || ms > before.ms)) before = { ms, hPa: obs.hPa };
    if (ms > targetMs && (after === null || ms < after.ms)) after = { ms, hPa: obs.hPa };
  }
  if (before === null || after === null) return null;
  return before.hPa + ((after.hPa - before.hPa) * (targetMs - before.ms)) / (after.ms - before.ms);
}

/** The ok response: every reported hPa is rounded to one decimal; the change comes from the rounded values. */
function ok(
  source: 'dmi' | 'model',
  hPaRaw: number,
  observedAtMs: number,
  threeHoursAgoRaw: number | null,
  now: Date,
  fetchedAt: Date,
): BarometerResponse {
  const hPa = round1(hPaRaw);
  const hPaThreeHoursAgo = threeHoursAgoRaw === null ? null : round1(threeHoursAgoRaw);
  const changeHpa = hPaThreeHoursAgo === null ? null : round1(hPa - hPaThreeHoursAgo);
  return {
    status: 'ok',
    now: now.toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    source,
    place: BAROMETER_PLACE,
    hPa,
    observedAt: new Date(observedAtMs).toISOString(),
    hPaThreeHoursAgo,
    changeHpa,
    trend: changeHpa === null ? null : changeHpa > BAROMETER_STEADY_HPA ? 'rising' : changeHpa < -BAROMETER_STEADY_HPA ? 'falling' : 'steady',
    zone: barometerZone(hPa),
  };
}

/** Strict reader for a DMI metObs FeatureCollection (`pressure_at_sea`). Any unexpected feature refuses the whole
 *  body (null = malformed); zero features means the station returned nothing ('empty'). */
export function parseDmiBody(body: unknown): DmiStation | 'empty' | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const features = (body as Record<string, unknown>).features;
  if (!Array.isArray(features)) return null;
  if (features.length === 0) return 'empty';
  let stationId: string | null = null;
  let position: { lat: number; lon: number } | null = null;
  const rows: { ms: number; hPa: number }[] = [];
  for (const feature of features) {
    if (typeof feature !== 'object' || feature === null) return null;
    const properties = (feature as Record<string, unknown>).properties;
    if (typeof properties !== 'object' || properties === null) return null;
    const p = properties as Record<string, unknown>;
    if (p.parameterId !== 'pressure_at_sea') return null;
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) return null;
    const ms = isoZMs(p.observed);
    if (ms === null) return null;
    if (typeof p.stationId !== 'string' || p.stationId === '') return null;
    if (stationId === null) stationId = p.stationId;
    else if (stationId !== p.stationId) return null;
    const coords = lonLat((feature as Record<string, unknown>).geometry);
    if (coords === null) return null;
    if (position === null) position = coords;
    rows.push({ ms, hPa: p.value });
  }
  // Unreachable with a non-empty features array, but a missing station is refused, never guessed.
  if (stationId === null || position === null) return null;
  rows.sort((x, y) => y.ms - x.ms); // newest first
  return {
    id: stationId,
    lat: position.lat,
    lon: position.lon,
    obs: rows.map((row) => ({ timeUtc: new Date(row.ms).toISOString(), hPa: row.hPa })),
  };
}

/** Strict reader for Open-Meteo `dmi_seamless` current and hourly `pressure_msl`. Null pressures are skipped;
 *  anything else unexpected refuses the whole body (null). */
export function parseOpenMeteoBody(body: unknown): ModelSeries | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.current !== 'object' || b.current === null) return null;
  const current = b.current as Record<string, unknown>;
  const currentMs = minuteMs(current.time);
  if (currentMs === null) return null;
  if (typeof current.pressure_msl !== 'number' || !Number.isFinite(current.pressure_msl)) return null;
  if (typeof b.hourly !== 'object' || b.hourly === null) return null;
  const hourly = b.hourly as Record<string, unknown>;
  if (!Array.isArray(hourly.time) || !Array.isArray(hourly.pressure_msl) || hourly.time.length !== hourly.pressure_msl.length) return null;
  const rows: { ms: number; hPa: number }[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const ms = minuteMs(hourly.time[i]);
    if (ms === null) return null;
    const pressure = hourly.pressure_msl[i];
    if (pressure === null) continue;
    if (typeof pressure !== 'number' || !Number.isFinite(pressure)) return null;
    rows.push({ ms, hPa: pressure });
  }
  rows.sort((x, y) => x.ms - y.ms); // ascending
  return {
    currentTimeUtc: new Date(currentMs).toISOString(),
    currentHPa: current.pressure_msl,
    hourly: rows.map((row) => ({ timeUtc: new Date(row.ms).toISOString(), hPa: row.hPa })),
  };
}

/** Great-circle distance in km (mean-earth radius). */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * TO_RADIANS;
  const dLon = (b.lon - a.lon) * TO_RADIANS;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const chord = sinLat * sinLat + Math.cos(a.lat * TO_RADIANS) * Math.cos(b.lat * TO_RADIANS) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(chord));
}

/** Inverse-distance-squared weighted pressure (weights 1/d^2); a point closer than 0.001 km gives its own value. */
export function idwHpa(points: readonly { lat: number; lon: number; hPa: number }[], target: { lat: number; lon: number }): number {
  let weightSum = 0;
  let weightedSum = 0;
  for (const point of points) {
    const distanceKm = haversineKm(point, target);
    if (distanceKm < COINCIDENT_KM) return point.hPa;
    const weight = 1 / (distanceKm * distanceKm);
    weightSum += weight;
    weightedSum += weight * point.hPa;
  }
  return weightedSum / weightSum;
}

/** Project the dashboard barometer from parsed provider rows: fresh DMI stations weighted by distance, the model
 *  standing in when every station is stale, and 'empty' when neither is fresh. */
export function projectBarometer(input: {
  stations: readonly DmiStation[];
  model: ModelSeries | null;
  now: Date;
  fetchedAt: Date;
}): BarometerResponse {
  const nowMs = input.now.getTime();
  const target = { lat: BAROMETER_LATITUDE, lon: BAROMETER_LONGITUDE };

  // Fresh stations: those whose newest obs is within the freshness window.
  const used: { lat: number; lon: number; newestMs: number; newestHPa: number; obs: readonly DmiObs[] }[] = [];
  for (const station of input.stations) {
    let newest: { ms: number; hPa: number } | null = null;
    for (const obs of station.obs) {
      const ms = Date.parse(obs.timeUtc);
      if (!Number.isFinite(ms)) continue;
      if (newest === null || ms > newest.ms) newest = { ms, hPa: obs.hPa };
    }
    if (newest === null || !isFresh(newest.ms, nowMs)) continue;
    used.push({ lat: station.lat, lon: station.lon, newestMs: newest.ms, newestHPa: newest.hPa, obs: station.obs });
  }

  if (used.length > 0) {
    // Measured: IDW of the fresh stations' newest values, observed at the oldest of those times.
    const observedAtMs = Math.min(...used.map((u) => u.newestMs));
    const history: { lat: number; lon: number; hPa: number }[] = [];
    let complete = true;
    for (const u of used) {
      const hPa = obsNear(u.obs, observedAtMs - THREE_HOURS_MS);
      if (hPa === null) {
        complete = false;
        break;
      }
      history.push({ lat: u.lat, lon: u.lon, hPa });
    }
    return ok(
      'dmi',
      idwHpa(used.map((u) => ({ lat: u.lat, lon: u.lon, hPa: u.newestHPa })), target),
      observedAtMs,
      complete ? idwHpa(history, target) : null,
      input.now,
      input.fetchedAt,
    );
  }

  if (input.model !== null) {
    const currentMs = Date.parse(input.model.currentTimeUtc);
    if (Number.isFinite(currentMs) && isFresh(currentMs, nowMs)) {
      return ok('model', input.model.currentHPa, currentMs, interpolateHourly(input.model.hourly, currentMs - THREE_HOURS_MS), input.now, input.fetchedAt);
    }
  }

  return { status: 'unavailable', now: input.now.toISOString(), reason: 'empty', note: BAROMETER_REASON_NOTES.empty };
}
