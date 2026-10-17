import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { haversineKm, idwHpa, parseDmiBody, parseOpenMeteoBody, type DmiStation } from './barometer.ts';

// Real DMI metObs and Open-Meteo captures (17 Oct 2026, ~06:45 UTC). Each fixture is a single long line, so it is
// loaded with readFileSync, never opened directly. Hand-verified expectations (now = 2026-10-17T06:45:00Z):
// 06180 Kastrup lon 12.6454 lat 55.614 (10.44 km from Trianglen); 06181 Jaegersborg 12.5263/55.7664 (8.08 km).
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/monitors/${name}`, import.meta.url), 'utf8'));

const trianglen = { lat: 55.6996, lon: 12.5772 }; // BAROMETER_LATITUDE / BAROMETER_LONGITUDE
const kastrup = { lat: 55.614, lon: 12.6454, hPa: 1020.2 }; // station 06180, newest obs at 06:40Z
const jaegersborg = { lat: 55.7664, lon: 12.5263, hPa: 1020.27 }; // station 06181, newest obs at 06:40Z

function parseStationFixture(name: string): DmiStation {
  const station = parseDmiBody(fixture(name));
  if (station === null || station === 'empty') throw new Error(`expected a parsed station from ${name}`);
  return station;
}

/** A well-formed DMI observation feature; `over` replaces properties to build malformed bodies. */
const dmiFeature = (over: Record<string, unknown> = {}) => ({
  geometry: { type: 'Point', coordinates: [12.6454, 55.614] },
  properties: { parameterId: 'pressure_at_sea', value: 1020.2, observed: '2026-10-17T06:40:00Z', stationId: '06180', ...over },
});
const dmiBody = (features: unknown[]) => ({ type: 'FeatureCollection', features });

describe('parseDmiBody', () => {
  it('parses the real 06180 capture: id, coordinates, 40 obs newest first', () => {
    const station = parseStationFixture('dmi-pressure-06180.json');
    expect(station).toMatchObject({ id: '06180', lat: kastrup.lat, lon: kastrup.lon });
    expect(station.obs).toHaveLength(40);
    expect(station.obs[0]).toEqual({ timeUtc: '2026-10-17T06:40:00.000Z', hPa: 1020.2 });
    expect(station.obs).toContainEqual({ timeUtc: '2026-10-17T03:40:00.000Z', hPa: 1018.9 }); // 3 h before the newest
    const times = station.obs.map((row) => Date.parse(row.timeUtc));
    expect(times).toEqual([...times].sort((a, b) => b - a)); // newest first
  });

  it('parses the real 06181 capture: id, coordinates, 40 obs newest first', () => {
    const station = parseStationFixture('dmi-pressure-06181.json');
    expect(station).toMatchObject({ id: '06181', lat: jaegersborg.lat, lon: jaegersborg.lon });
    expect(station.obs).toHaveLength(40);
    expect(station.obs[0]).toEqual({ timeUtc: '2026-10-17T06:40:00.000Z', hPa: 1020.27 });
    expect(station.obs).toContainEqual({ timeUtc: '2026-10-17T03:40:00.000Z', hPa: 1018.83 }); // 3 h before the newest
    const times = station.obs.map((row) => Date.parse(row.timeUtc));
    expect(times).toEqual([...times].sort((a, b) => b - a)); // newest first
  });

  it('reports an empty FeatureCollection and refuses malformed bodies', () => {
    expect(parseDmiBody(dmiBody([]))).toBe('empty');
    expect(parseDmiBody(dmiBody([dmiFeature({ parameterId: 'temp_dry' })]))).toBeNull(); // another parameterId
    expect(parseDmiBody(dmiBody([dmiFeature({ value: '1020.2' })]))).toBeNull(); // non-numeric value
    expect(parseDmiBody(dmiBody([dmiFeature({ observed: '2026-10-17T08:40:00+02:00' })]))).toBeNull(); // not UTC 'Z'
    expect(parseDmiBody(dmiBody([dmiFeature(), dmiFeature({ stationId: '06181' })]))).toBeNull(); // mixed stationIds
  });
});

describe('parseOpenMeteoBody', () => {
  it('parses the real capture: current pressure at its UTC minute, hourly rows ascending', () => {
    const model = parseOpenMeteoBody(fixture('open-meteo-pressure-dmi.json'));
    if (model === null) throw new Error('expected a parsed model');
    expect(model.currentHPa).toBe(1019.9);
    expect(model.currentTimeUtc).toBe('2026-10-17T06:45:00.000Z');
    const times = model.hourly.map((row) => row.timeUtc);
    expect(times.length).toBeGreaterThan(0);
    expect([...times].sort()).toEqual(times); // ISO strings: lexicographic order == chronological order
  });

  it('refuses an hourly columns length mismatch', () => {
    const body = fixture('open-meteo-pressure-dmi.json') as { hourly: { time: unknown[]; pressure_msl: unknown[] } };
    const mismatched = { ...body, hourly: { ...body.hourly, pressure_msl: body.hourly.pressure_msl.slice(1) } };
    expect(parseOpenMeteoBody(mismatched)).toBeNull();
  });
});

describe('geometry', () => {
  it('haversineKm: Trianglen to 06180 is 10.44 km, to 06181 is 8.08 km', () => {
    expect(haversineKm(trianglen, kastrup)).toBeCloseTo(10.44, 1);
    expect(haversineKm(trianglen, jaegersborg)).toBeCloseTo(8.08, 1);
  });

  it('idwHpa: inverse-square-distance weights; one station passes through; a coincident point returns its own value', () => {
    expect(idwHpa([kastrup, jaegersborg], trianglen)).toBeCloseTo(1020.2437, 3);
    expect(idwHpa([jaegersborg], trianglen)).toBe(1020.27);
    expect(idwHpa([{ ...trianglen, hPa: 1019.9 }], trianglen)).toBe(1019.9); // distance 0
  });
});
