import { HEALTH_DAILY_CSV, HealthResponse } from '@vault-companion/contracts';
import { expect, it } from 'vitest';
import { createHealthService } from './health.ts';
import { StoreUnavailable } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const NOW = new Date('2026-05-01T12:00:00Z'); // Copenhagen: 2026-05-01, so yesterday is 2026-04-30.
const TZ = 'Europe/Copenhagen';
const HEADER = 'date,weekday,steps,distance_km,flights,active_kcal,walking_speed_kmh,first_move,last_move,late_steps,early_steps,headphone_min,headphone_db,loud_min,in_bed_h';

interface Day {
  readonly date: string;
  readonly steps?: string;
  readonly first?: string;
  readonly last?: string;
  readonly headphone?: string;
}

/** A normal day: steps > 0 and a first move, so it counts as data. */
const data = (date: string, steps: number, extra: Partial<Day> = {}): Day =>
  ({ date, steps: String(steps), first: '11:00', last: '23:00', headphone: '60', ...extra });

function csv(days: readonly Day[], header = HEADER): string {
  const rows = days.map((d) =>
    [d.date, 'Mon', d.steps ?? '0', '1', '0', '0', '0', d.first ?? '', d.last ?? '', '0', '0', d.headphone ?? '0', '0', '0', '8'].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + n * 86_400_000).toISOString().slice(0, 10);
}

async function setup(csvText: string) {
  const store = await InMemoryStore.create({ [HEALTH_DAILY_CSV]: csvText });
  return { store, read: createHealthService({ store, now: () => NOW, timeZone: TZ }).readHealth };
}

const byKey = (r: HealthResponse, key: string) => r.metrics.find((m) => m.key === key)!;

it('returns the shown day with known medians, comparison and a 30-day series', async () => {
  const days: Day[] = [];
  for (let i = 1; i <= 29; i++) days.push(data(addDays('2026-04-30', -i), 5000)); // 2026-04-01..04-29
  days.push(data('2026-04-30', 5600, { headphone: '70', first: '11:20', last: '00:40' }));
  const { store, read } = await setup(csv(days));
  const r = HealthResponse.parse(await read());
  expect(store.writeCalls).toBe(0);
  expect(r).toMatchObject({ status: 'ok', day: '2026-04-30', staleDays: 0, now: NOW.toISOString() });
  expect(r.metrics.map((m) => m.key)).toEqual(['steps', 'headphone_min', 'first_move', 'last_move']);
  expect(byKey(r, 'steps')).toMatchObject({ value: 5600, baseline: 5000, compare: 'above' });
  expect(byKey(r, 'headphone_min')).toMatchObject({ value: 70, baseline: 60, compare: 'above' });
  expect(byKey(r, 'first_move')).toMatchObject({ value: 500, baseline: 480, compare: 'usual' });
  expect(byKey(r, 'last_move')).toMatchObject({ value: 1300, baseline: 1200, compare: 'above' });
  const steps = byKey(r, 'steps');
  expect(steps.series).toHaveLength(30);
  expect(steps.series[0]).toBe(5000);
  expect(steps.series[29]).toBe(5600);
});

it('maps times onto the 03:00 behavioural day so medians never wrap midnight', async () => {
  const days: Day[] = [];
  for (let i = 1; i <= 20; i++) days.push(data(addDays('2026-04-30', -i), 5000, { first: '03:00', last: '23:00' }));
  days.push(data('2026-04-30', 5000, { first: '01:30', last: '00:40' }));
  const r = HealthResponse.parse(await (await setup(csv(days))).read());
  expect(byKey(r, 'first_move').value).toBe(1350); // 01:30
  expect(byKey(r, 'last_move').value).toBe(1300); // 00:40, just after midnight
  expect(byKey(r, 'first_move').baseline).toBe(0); // 03:00
});

it('treats a steps-0, empty-first-move day as no data and excludes it from baselines', async () => {
  const days: Day[] = [];
  for (let i = 0; i < 14; i++) days.push(data(addDays('2026-04-30', -(i + 1)), 8000));
  for (let i = 14; i < 29; i++) days.push({ date: addDays('2026-04-30', -(i + 1)), steps: '0', first: '' });
  days.push(data('2026-04-30', 8000));
  const r = HealthResponse.parse(await (await setup(csv(days))).read());
  // If the 15 sentinel days counted as 0, the median would collapse; 14 non-null values give 8000.
  expect(byKey(r, 'steps')).toMatchObject({ value: 8000, baseline: 8000, compare: 'usual' });
  expect(byKey(r, 'steps').series[0]).toBeNull(); // 2026-04-01 is a no-data day
});

it('answers unknown when fewer than 14 baseline values exist', async () => {
  const days: Day[] = [];
  for (let i = 1; i <= 10; i++) days.push(data(addDays('2026-04-30', -i), 5000));
  days.push(data('2026-04-30', 6000));
  const r = HealthResponse.parse(await (await setup(csv(days))).read());
  expect(byKey(r, 'steps')).toMatchObject({ value: 6000, baseline: null, compare: 'unknown' });
});

it('reports a stale export through staleDays and ignores today\'s partial row', async () => {
  const days: Day[] = [];
  for (let i = 1; i <= 20; i++) days.push(data(addDays('2026-04-25', -i), 5000));
  days.push(data('2026-04-25', 5000));
  days.push(data('2026-05-01', 99999)); // today: never the shown day
  const { store, read } = await setup(csv(days));
  const r = HealthResponse.parse(await read());
  expect(r).toMatchObject({ status: 'ok', day: '2026-04-25', staleDays: 5 });
  expect(byKey(r, 'steps').value).not.toBe(99999);
  expect(store.calls.filter((c) => c === 'writeFile' || c === 'writeFiles')).toEqual([]);
});

it('is missing when the file is absent and unreadable for a bad header or invalid bytes', async () => {
  const empty = await InMemoryStore.create({});
  expect(await createHealthService({ store: empty, now: () => NOW, timeZone: TZ }).readHealth()).toMatchObject({ status: 'missing', metrics: [] });

  const badHeader = csv([data('2026-04-30', 5000)], HEADER.replace('headphone_min,', ''));
  expect(await (await setup(badHeader)).read()).toMatchObject({ status: 'unreadable', metrics: [] });

  const store = await InMemoryStore.create({ [HEALTH_DAILY_CSV]: new Uint8Array([0xff, 0xfe, 0x00]) });
  expect(await createHealthService({ store, now: () => NOW, timeZone: TZ }).readHealth()).toMatchObject({ status: 'unreadable' });
});

it('refuses an oversized export and a blob that does not match the listing', async () => {
  const big = await InMemoryStore.create({ [HEALTH_DAILY_CSV]: new Uint8Array(1024 * 1024 + 1) });
  expect(await createHealthService({ store: big, now: () => NOW, timeZone: TZ }).readHealth()).toMatchObject({ status: 'unreadable', metrics: [] });

  const { store, read } = await setup(csv([data('2026-04-30', 5000)]));
  const real = store.readFile.bind(store);
  store.readFile = async (path, at) => { const file = await real(path, at); return file && { ...file, blobSha: 'f'.repeat(40) }; };
  expect(await read()).toMatchObject({ status: 'unreadable' });
});

it('maps a store outage to upstream-unavailable without leaking any cell text', async () => {
  const store = await InMemoryStore.create({ [HEALTH_DAILY_CSV]: csv([data('2026-04-30', 43210)]) });
  store.listFiles = async () => { throw new StoreUnavailable('43210'); };
  const result = await createHealthService({ store, now: () => NOW, timeZone: TZ }).readHealth();
  expect(result).toEqual({ code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true });
  expect(JSON.stringify(result)).not.toContain('43210');
});
