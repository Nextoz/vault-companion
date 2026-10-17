// Sun and moon maths for the daylight monitor (M7). Pure: no clock, no network. Formulas follow SunCalc
// (Astronomy Answers, Julian days from J2000); accurate to about a minute at mid latitudes, which is all a
// "sunrise / sunset / golden hour" line needs.

export type SunDay =
  | {
      kind: 'normal';
      date: string;
      sunrise: string;
      sunset: string;
      solarNoon: string;
      /** (sunset - sunrise) in minutes, one decimal. */
      daylightMinutes: number;
      /** When the sun sinks through +6 degrees before sunset. */
      goldenHourStart: string;
    }
  | { kind: 'polar-day' | 'polar-night'; date: string; solarNoon: string; daylightMinutes: number };

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = RAD * 23.4397;
const SUNRISE_ALTITUDE = -0.833;
const GOLDEN_ALTITUDE = 6;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const toDays = (ms: number): number => ms / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j: number): Date => new Date((j + 0.5 - J1970) * DAY_MS);
const meanAnomaly = (d: number): number => RAD * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (m: number): number =>
  m + RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m)) + RAD * 102.9372 + Math.PI;
const declination = (l: number, b: number): number =>
  Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const rightAscension = (l: number, b: number): number =>
  Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));

function parseDate(date: string): number {
  const match = DATE.exec(date);
  if (!match) throw new RangeError('invalid date');
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new RangeError('invalid date');
  return ms;
}

function checkCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new RangeError('invalid latitude');
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new RangeError('invalid longitude');
}

/** Sun times for one local calendar date at a place. Instants are ISO strings in UTC. */
export function sunDay(date: string, latitude: number, longitude: number): SunDay {
  checkCoordinates(latitude, longitude);
  // Local solar noon of that calendar date, so the transit found below belongs to this date at any longitude.
  const noonMs = parseDate(date) + 12 * 3_600_000 - (longitude / 15) * 3_600_000;
  const lw = RAD * -longitude;
  const phi = RAD * latitude;
  const n = Math.round(toDays(noonMs) - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const m = meanAnomaly(ds);
  const l = eclipticLongitude(m);
  const dec = declination(l, 0);
  const transit = (approx: number): number => J2000 + approx + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
  const jNoon = transit(ds);
  const solarNoon = fromJulian(jNoon).toISOString();
  const cosHourAngle = (altitude: number): number =>
    (Math.sin(altitude * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  const setFor = (cos: number): number => transit(J0 + (Math.acos(cos) + lw) / (2 * Math.PI) + n);

  const horizon = cosHourAngle(SUNRISE_ALTITUDE);
  if (horizon > 1) return { kind: 'polar-night', date, solarNoon, daylightMinutes: 0 };
  if (horizon < -1) return { kind: 'polar-day', date, solarNoon, daylightMinutes: 1440 };
  const jSet = setFor(horizon);
  const jRise = jNoon - (jSet - jNoon);
  const golden = cosHourAngle(GOLDEN_ALTITUDE);
  const goldenHourStart = golden >= -1 && golden <= 1 ? fromJulian(setFor(golden)).toISOString() : solarNoon;
  return {
    kind: 'normal',
    date,
    sunrise: fromJulian(jRise).toISOString(),
    sunset: fromJulian(jSet).toISOString(),
    solarNoon,
    daylightMinutes: Math.round((jSet - jRise) * 1440 * 10) / 10,
    goldenHourStart,
  };
}

/** Change in daylight against the previous calendar date, in whole seconds (negative = shorter). */
export function daylightChangeSeconds(date: string, latitude: number, longitude: number): number {
  const previous = new Date(parseDate(date) - DAY_MS).toISOString().slice(0, 10);
  const minutes = (day: string): number => {
    const sun = sunDay(day, latitude, longitude);
    if (sun.kind !== 'normal') return sun.daylightMinutes;
    return (Date.parse(sun.sunset) - Date.parse(sun.sunrise)) / 60_000;
  };
  return Math.round((minutes(date) - minutes(previous)) * 60);
}

/** Illuminated fraction of the moon (2 decimals) and whether it is growing, at an instant. */
export function moonPhase(at: Date): { illumination: number; waxing: boolean } {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('invalid instant');
  const d = toDays(ms);
  const sunL = eclipticLongitude(meanAnomaly(d));
  const sunDec = declination(sunL, 0);
  const sunRa = rightAscension(sunL, 0);
  const moonL = RAD * (218.316 + 13.176396 * d);
  const moonM = RAD * (134.963 + 13.064993 * d);
  const moonF = RAD * (93.272 + 13.22935 * d);
  const l = moonL + RAD * 6.289 * Math.sin(moonM);
  const b = RAD * 5.128 * Math.sin(moonF);
  const distanceKm = 385001 - 20905 * Math.cos(moonM);
  const moonDec = declination(l, b);
  const moonRa = rightAscension(l, b);
  const sunDistanceKm = 149598000;
  const elongation = Math.acos(Math.sin(sunDec) * Math.sin(moonDec) + Math.cos(sunDec) * Math.cos(moonDec) * Math.cos(sunRa - moonRa));
  const inc = Math.atan2(sunDistanceKm * Math.sin(elongation), distanceKm - sunDistanceKm * Math.cos(elongation));
  const angle = Math.atan2(
    Math.cos(sunDec) * Math.sin(sunRa - moonRa),
    Math.sin(sunDec) * Math.cos(moonDec) - Math.cos(sunDec) * Math.sin(moonDec) * Math.cos(sunRa - moonRa),
  );
  return { illumination: Math.round(((1 + Math.cos(inc)) / 2) * 100) / 100, waxing: angle < 0 };
}
