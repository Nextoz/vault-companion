import { DashboardResponse, HealthResponse, ScoutsResponse } from '@vault-companion/contracts';
import type { ScoutStatus } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { buildLine, dataSourceRows, scoutRows, shortRevision, stateLabel } from './status-sheet.ts';

const now = Date.parse('2026-09-30T13:00:00Z');
const REV = 'a'.repeat(40);

const scout = (over: Partial<ScoutStatus> = {}): ScoutStatus => ({
  schemaVersion: 1, scoutId: 'learning', displayName: 'Learning', schedule: 'daily', expectedEveryHours: 24,
  lastAttemptAt: '2026-09-30T11:00:00Z', lastSuccessAt: '2026-09-30T11:00:00Z', runStatus: 'success',
  sources: { configured: 2, successful: 2 }, aiHealth: 'healthy', findings: 0, added: 0, errors: 0,
  lastError: null, latestOutput: null, history: [], ...over,
});

const scoutsResponse = (entries: ScoutsResponse['scouts']) =>
  ScoutsResponse.parse({ revision: REV, now: '2026-09-30T12:00:00Z', scouts: entries });

const cardMeta = { title: 'Card', provenance: 'Source', observedAt: null, fetchedAt: '2026-09-30T12:00:00Z', note: null, drillthrough: null };
const weatherOk = {
  id: 'weather', status: 'ok', ...cardMeta,
  projection: {
    location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
    now: '2026-09-30T12:00:00Z',
    models: [{
      model: 'dmi_harmonie_arome_europe', label: 'DMI HARMONIE AROME Europe', resolutionKm: 2,
      sourceUrl: 'https://open-meteo.com/en/docs/dmi-api', retrievedAt: '2026-09-30T11:55:00Z',
      expectedPoints: 48, points: [], missingIntervals: 48,
    }],
    agreement: 'single-model',
    coverage: { expectedPoints: 48, primaryReturned: 0, comparisonReturned: 0, primaryMissingIntervals: 48, comparisonMissingIntervals: 48 },
    runWindow: null, partialError: 'one-model-unavailable', attribution: 'Open-Meteo', termsUrl: 'https://open-meteo.com/en/terms',
  },
};
const marketOk = {
  id: 'market', status: 'ok', ...cardMeta, observedAt: '2026-09-30T12:00:30Z',
  ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60_000, providerTime: '2026-09-30T12:00:30Z' },
  series: null,
};
const unavailable = (id: 'weather' | 'market') => ({ id, status: 'unavailable', ...cardMeta, reason: 'timeout' });

const dashboard = (ok = true) =>
  DashboardResponse.parse({ now: '2026-09-30T12:00:00Z', cards: ok ? [weatherOk, marketOk] : [unavailable('weather'), unavailable('market')] });

const health = (status: 'ok' | 'missing') => HealthResponse.parse(status === 'ok'
  ? { revision: REV, now: '2026-09-30T12:00:00Z', status, day: '2026-09-29', staleDays: 0, metrics: [] }
  : { revision: REV, now: '2026-09-30T12:00:00Z', status, metrics: [] });

describe('status sheet helpers', () => {
  it('shows a twelve-character revision', () => {
    expect(shortRevision('2915455abcdef1234567890')).toBe('2915455abcde');
    expect(shortRevision('abc')).toBe('abc');
  });

  it('builds the app line and reads an absent build stamp as unknown', () => {
    expect(buildLine('deadbeef', null, 'Europe/Copenhagen')).toBe('App deadbeef \u00b7 built unknown');
    expect(buildLine('deadbeef', '2026-09-30T12:00:00Z', 'Europe/Copenhagen')).toBe('App deadbeef \u00b7 built 30 Sept 2026, 14:00');
  });

  it('keeps the owner wording for a degraded run', () => {
    expect(stateLabel('Degraded')).toBe('Ran with problems');
    expect(stateLabel('Healthy')).toBe('Healthy');
  });

  it('lists one row per scout, skipping the calendar tracker, with state and last run', () => {
    const rows = scoutRows(scoutsResponse([
      { file: 'Scouts/learning.md', state: 'ok', status: scout() },
      { file: 'Scouts/triage.md', state: 'ok', status: scout({ scoutId: 'triage-applier', displayName: 'Triage' }) },
      { file: 'Scouts/broken.md', state: 'unreadable' },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'Learning', state: 'Healthy', run: '2026-09-30T11:00:00Z' });
    expect(rows[1]).toMatchObject({ file: 'Scouts/broken.md', name: 'Scouts/broken.md', state: 'No status yet', run: null });
  });

  it('reads each data source time from the copies the app already holds', () => {
    const rows = dataSourceRows({ dashboard: dashboard(), health: health('ok') }, now, 'Europe/Copenhagen');
    expect(rows).toEqual([
      { label: 'DMI HARMONIE AROME Europe', time: '13:55' },
      { label: 'Markets', time: '14:00' },
      { label: 'Health export', time: '2026-09-29' },
    ]);
  });

  it('shows "-" for a source with no in-memory copy, never a guess', () => {
    expect(dataSourceRows({ dashboard: null, health: null }, now, 'Europe/Copenhagen')).toEqual([
      { label: 'Weather models', time: null },
      { label: 'Markets', time: null },
      { label: 'Health export', time: null },
    ]);
    expect(dataSourceRows({ dashboard: dashboard(false), health: health('missing') }, now, 'Europe/Copenhagen'))
      .toEqual([{ label: 'Weather models', time: null }, { label: 'Markets', time: null }, { label: 'Health export', time: null }]);
  });
});