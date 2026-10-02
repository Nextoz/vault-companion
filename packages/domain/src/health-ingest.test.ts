import { HEALTH_DAILY_CSV } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createHealthIngestService } from './health-ingest.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TZ = 'Europe/Copenhagen';
const NOW = new Date('2026-09-30T12:00:00+02:00');
const HEADER =
  'date,weekday,steps,distance_km,flights,active_kcal,walking_speed_kmh,first_move,last_move,late_steps,early_steps,headphone_min,headphone_db,loud_min,in_bed_h';

const csv = (rows: readonly string[], eol = '\n') => `${[HEADER, ...rows].join(eol)}${eol}`;
const row = (date: string, weekday: string, overrides: Partial<Record<string, string>> = {}) => {
  const values = ['date', 'weekday', 'steps', 'distance_km', 'flights', 'active_kcal', 'walking_speed_kmh', 'first_move', 'last_move', 'late_steps', 'early_steps', 'headphone_min', 'headphone_db', 'loud_min', 'in_bed_h'];
  const data: Record<string, string> = { date, weekday, steps: '0', distance_km: '0', flights: '0', active_kcal: '0', walking_speed_kmh: '', first_move: '', last_move: '', late_steps: '0', early_steps: '0', headphone_min: '0', headphone_db: '', loud_min: '0', in_bed_h: '' };
  Object.assign(data, overrides);
  return values.map((k) => data[k]!).join(',');
};

function payload(overrides: Record<string, string> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    from: '2026-09-29T00:00:00+02:00',
    sentAt: '2026-09-29T10:00:00+02:00',
    steps: '2026-09-29T08:00:00+02:00|2026-09-29T09:00:00+02:00|620|count',
    distance: '',
    flights: '',
    activeEnergy: '',
    walkingSpeed: '',
    headphone: '',
    sleep: '',
    ...overrides,
  });
}

async function ingest(seed: string, body: string) {
  const store = await InMemoryStore.create({ [HEALTH_DAILY_CSV]: seed });
  const service = createHealthIngestService({ store, now: () => NOW, timeZone: TZ });
  return { store, result: await service.ingest(body) };
}

describe('health ingest aggregation and merge', () => {
  it.each(['\n', '\r\n'] as const)('keeps %j line endings and other rows byte-identical', async (eol) => {
    const untouched = '2026-09-28,Mon,100,1,2,300,4.5,06:00,22:00,0,0,30,75.0,5,7.5';
    const seed = csv([untouched, row('2026-09-29', 'Tue')], eol);
    const { store, result } = await ingest(seed, payload());
    expect(result).toMatchObject({ ok: true, days: ['2026-09-29'] });
    const expected = csv([untouched, row('2026-09-29', 'Tue', { steps: '620', first_move: '08:00', last_move: '09:00' })], eol);
    expect(store.text(HEALTH_DAILY_CSV)).toBe(expected);
  });

  it('attributes 02:59 and 03:00 steps across the behavioural-day edge', async () => {
    const seed = csv([row('2026-09-28', 'Mon'), row('2026-09-29', 'Tue')]);
    const body = payload({
      from: '2026-09-28T00:00:00+02:00',
      sentAt: '2026-09-29T10:00:00+02:00',
      steps:
        '2026-09-29T02:59:00+02:00|2026-09-29T02:59:30+02:00|25|count\n' +
        '2026-09-29T03:00:00+02:00|2026-09-29T03:00:30+02:00|30|count',
    });
    const { store, result } = await ingest(seed, body);
    expect(result).toMatchObject({ ok: true, days: ['2026-09-28', '2026-09-29'] });
    expect(store.text(HEALTH_DAILY_CSV)).toBe(
      csv([
        row('2026-09-28', 'Mon', { first_move: '02:59', last_move: '02:59', late_steps: '25' }),
        row('2026-09-29', 'Tue', { steps: '55', first_move: '03:00', last_move: '03:00', early_steps: '30' }),
      ]),
    );
  });

  it('starts at the next date when from is not local midnight and leaves earlier rows untouched', async () => {
    const older = '2026-09-29,Tue,99,9,9,9,9,09:00,21:00,9,9,9,9,9,9';
    const seed = csv([older, row('2026-09-30', 'Wed')]);
    const body = payload({
      from: '2026-09-29T09:00:00+02:00',
      sentAt: '2026-09-30T10:00:00+02:00',
      steps:
        '2026-09-29T10:00:00+02:00|2026-09-29T11:00:00+02:00|99|count\n' +
        '2026-09-30T10:00:00+02:00|2026-09-30T11:00:00+02:00|100|count',
    });
    const { store, result } = await ingest(seed, body);
    expect(result).toMatchObject({ ok: true, days: ['2026-09-30'] });
    expect(store.text(HEALTH_DAILY_CSV)).toBe(
      csv([older, row('2026-09-30', 'Wed', { steps: '100', first_move: '10:00', last_move: '11:00' })]),
    );
  });

  it('uses Copenhagen dates across the DST transition', async () => {
    const seed = csv([row('2026-03-29', 'Sun')]);
    const body = payload({
      from: '2026-03-29T00:00:00+01:00',
      sentAt: '2026-03-29T12:00:00+02:00',
      steps: '2026-03-29T03:30:00+02:00|2026-03-29T04:30:00+02:00|25|count',
    });
    const { store, result } = await ingest(seed, body);
    expect(result).toMatchObject({ ok: true, days: ['2026-03-29'] });
    expect(store.text(HEALTH_DAILY_CSV)).toBe(
      csv([row('2026-03-29', 'Sun', { steps: '25', first_move: '03:30', last_move: '04:30', early_steps: '25' })]),
    );
  });

  it('rounds half-even and drops trailing zeros', async () => {
    const seed = csv([row('2026-09-29', 'Tue')]);
    const body = payload({
      distance: '2026-09-29T08:05:00+02:00|2026-09-29T08:06:00+02:00|1.125|km',
      activeEnergy: '2026-09-29T08:06:00+02:00|2026-09-29T08:07:00+02:00|2.5|kcal',
      sleep: '2026-09-29T22:00:00+02:00|2026-09-29T23:15:00+02:00|In Bed|',
    });
    const { store, result } = await ingest(seed, body);
    expect(result).toMatchObject({ ok: true, days: ['2026-09-29'] });
    expect(store.text(HEALTH_DAILY_CSV)).toBe(
      csv([
        row('2026-09-29', 'Tue', {
          steps: '620',
          distance_km: '1.12',
          active_kcal: '2',
          first_move: '08:00',
          last_move: '09:00',
          in_bed_h: '1.2',
        }),
      ]),
    );
  });

  it('does not commit when the same body is re-sent', async () => {
    const seed = csv([row('2026-09-29', 'Tue')]);
    const { store } = await ingest(seed, payload());
    const before = store.text(HEALTH_DAILY_CSV);
    const writesAfterFirst = store.writeCalls;
    const service = createHealthIngestService({ store, now: () => NOW, timeZone: TZ });
    const second = await service.ingest(payload());
    expect(second).toMatchObject({ ok: true, days: ['2026-09-29'] });
    expect(store.writeCalls).toBe(writesAfterFirst);
    expect(store.text(HEALTH_DAILY_CSV)).toBe(before);
  });

  it('refuses a locked request without writing', async () => {
    const seed = csv([row('2026-09-29', 'Tue')]);
    const { store, result } = await ingest(seed, payload({ steps: '', distance: '2026-09-29T08:00:00+02:00|2026-09-29T09:00:00+02:00|1|km' }));
    expect(result).toEqual({ ok: false, status: 422, error: 'Health was locked: no step samples' });
    expect(store.writeCalls).toBe(0);
  });

  it('refuses a grouped integer without echoing the value', async () => {
    const seed = csv([row('2026-09-29', 'Tue')]);
    const { store, result } = await ingest(seed, payload({ steps: '2026-09-29T08:00:00+02:00|2026-09-29T09:00:00+02:00|1.234|count' }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) {
      expect(result.error).toContain('steps line 1');
      expect(result.error).not.toContain('1.234');
    }
    expect(store.writeCalls).toBe(0);
  });
});
