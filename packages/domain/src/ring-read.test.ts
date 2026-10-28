import { HEALTH_VITALS_DAILY_CSV, RingDayResponse, ringSlotsPath } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { RING_METRICS, ringSlotHeader } from './ring-metrics.ts';
import { readRingDay, ringDayBounds } from './ring-read.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const row = (date: string) => `${date}T12:00:00+01:00,${RING_METRICS.map((m) => m.key === 'hr' ? '424242' : '').join(',')}`;
const csv = (...dates: string[]) => `${ringSlotHeader(1)}\n${dates.map(row).join('\n')}\n`;
const deps = (store: InMemoryStore) => ({ store, now: () => new Date('2026-10-28T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
describe('ring reads', () => {
  it.each([['2026-03-29', 92], ['2026-10-25', 100], ['2026-10-24', 96]])('bounds for %s', (date, count) => {
    const b = ringDayBounds(date, 'Europe/Copenhagen');
    expect(b.daySlots).toBe(count);
    expect(Date.parse(b.dayEnd) - Date.parse(b.dayStart)).toBe(count * 900000);
    expect(b.dayStart.slice(0, 19)).toBe(`${date}T00:00:00`);
  });
  it('emits every registry key, preserves null, stored starts and gaps, and sorts', async () => {
    const text = `${ringSlotHeader(1)}\n${row('2026-10-25').replace('12:00', '12:45')}\n${row('2026-10-25')}\n${row('2026-10-24')}\n`;
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: text });
    const body = RingDayResponse.parse(await readRingDay(deps(store), '2026-10-25'));
    expect(body.status).toBe('ok'); expect(body.slots).toHaveLength(2);
    expect(body.slots.map((s) => s.start)).toEqual(['2026-10-25T12:00:00+01:00', '2026-10-25T12:45:00+01:00']);
    expect(Object.keys(body.slots[0]!.values).sort()).toEqual(RING_METRICS.map((m) => m.key).sort());
    expect(body.slots[0]!.values.steps).toBeNull(); expect(body.slots[0]!.values.hr).toBe(424242);
    expect(body.prevDate).toBe('2026-10-24'); expect(store.writeCalls).toBe(0);
  });
  it('reads only one adjacent month per direction, never after today', async () => {
    const store = await InMemoryStore.create({
      [ringSlotsPath('2026-08')]: csv('2026-08-31', '2026-08-29'),
      [ringSlotsPath('2026-10')]: csv('2026-10-29', '2026-10-28', '2026-10-02'),
    });
    const read = vi.spyOn(store, 'readFile');
    const body = RingDayResponse.parse(await readRingDay(deps(store), '2026-09-15'));
    expect(body).toMatchObject({ status: 'missing', prevDate: '2026-08-31', nextDate: '2026-10-02' });
    expect(read.mock.calls.map(([path]) => path)).toEqual([ringSlotsPath('2026-08'), ringSlotsPath('2026-10')]);
    read.mockClear();
    const latest = RingDayResponse.parse(await readRingDay(deps(store), '2026-10-28'));
    expect(latest.nextDate).toBeNull();
    expect(read.mock.calls.every(([path, revision]) => !path.includes('2026-11') && revision === store.headCommit)).toBe(true);
  });
  it('does not read adjacent files when this month provides both neighbours', async () => {
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: csv('2026-10-01', '2026-10-03') });
    const list = vi.spyOn(store, 'listFiles');
    const body = RingDayResponse.parse(await readRingDay(deps(store), '2026-10-02'));
    expect(body).toMatchObject({ prevDate: '2026-10-01', nextDate: '2026-10-03' });
    expect(list).toHaveBeenCalledTimes(2); // requested month and daily file only
  });
  it('validates metric cells only on the requested canonical date', async () => {
    const corrupt = row('2026-10-24').replace('424242', 'broken');
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: `${ringSlotHeader(1)}\n${corrupt}\n${row('2026-10-25')}\n` });
    expect(await readRingDay(deps(store), '2026-10-25')).toMatchObject({ status: 'ok', prevDate: '2026-10-24', slots: [{ start: '2026-10-25T12:00:00+01:00' }] });
    expect(await readRingDay(deps(store), '2026-10-24')).toMatchObject({ status: 'unreadable', slots: [], prevDate: null, nextDate: null });
  });
  it('selects and navigates by canonical dates while preserving non-canonical stored offsets', async () => {
    const shifted = row('2026-10-25').replace('T12:00:00+01:00', 'T23:00:00+00:00');
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: `${ringSlotHeader(1)}\n${shifted}\n${row('2026-10-25')}\n` });
    expect(await readRingDay(deps(store), '2026-10-25')).toMatchObject({ status: 'ok', nextDate: '2026-10-26', slots: [{ start: '2026-10-25T12:00:00+01:00' }] });
    expect(await readRingDay(deps(store), '2026-10-26')).toMatchObject({ status: 'ok', prevDate: '2026-10-25', slots: [{ start: '2026-10-25T23:00:00+00:00' }] });
    // The same instant belongs to a different day in another zone, including after a warm read.
    expect(await readRingDay({ ...deps(store), timeZone: 'UTC' }, '2026-10-26')).toMatchObject({ status: 'missing', slots: [] });
  });
  it('uses adjacent month start cells for navigation without validating their metrics', async () => {
    const store = await InMemoryStore.create({
      [ringSlotsPath('2026-08')]: csv('2026-08-29', '2026-08-31').replaceAll('424242', 'broken'),
      [ringSlotsPath('2026-09')]: csv('2026-09-15'),
      [ringSlotsPath('2026-10')]: csv('2026-10-28', '2026-10-02', '2026-10-29').replaceAll('424242', 'broken'),
    });
    expect(await readRingDay(deps(store), '2026-09-15')).toMatchObject({ status: 'ok', prevDate: '2026-08-31', nextDate: '2026-10-02' });
  });
  it.each(['2026-09', '2026-10'])('refuses unparseable start cells anywhere in a used month (%s)', async (month) => {
    const store = await InMemoryStore.create({
      [ringSlotsPath('2026-10')]: csv('2026-10-25'),
      [ringSlotsPath(month)]: `${csv('2026-10-25')}not-a-date,\n`,
    });
    expect(await readRingDay(deps(store), '2026-10-25')).toMatchObject({ status: 'unreadable', slots: [] });
  });
  it.each(['duplicate', 'start', 'columns', 'sum'])('retains selected-row %s validation', async (guard) => {
    const valid = row('2026-10-25');
    const cells = valid.split(',');
    for (const key of ['sleepLightMin', 'sleepDeepMin']) cells[RING_METRICS.findIndex((m) => m.key === key) + 1] = '15';
    const bad = guard === 'duplicate' ? `${valid}\n${valid}` : guard === 'start' ? valid.replace('12:00:00', '12:01:00') : guard === 'columns' ? `${valid},` : cells.join(',');
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: `${ringSlotHeader(1)}\n${bad}\n` });
    expect(await readRingDay(deps(store), '2026-10-25')).toMatchObject({ status: 'unreadable', slots: [] });
  });
  it('preserves BOM, mixed line endings and an absent final newline', async () => {
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: `\uFEFF${ringSlotHeader(1)}\r\n${row('2026-10-24')}\r${row('2026-10-25')}\n${row('2026-10-26')}` });
    expect(await readRingDay(deps(store), '2026-10-25')).toMatchObject({ status: 'ok', prevDate: '2026-10-24', nextDate: '2026-10-26' });
  });
  it('never walks beyond adjacent months and does not inspect a future month', async () => {
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-08')]: csv('2026-08-01'), [ringSlotsPath('2026-11')]: 'bad' });
    const list = vi.spyOn(store, 'listFiles');
    expect(await readRingDay(deps(store), '2026-10-28')).toMatchObject({ status: 'missing', prevDate: null, nextDate: null });
    expect(list).toHaveBeenCalledTimes(3);
  });
  it.each(['', '2026-02-30', '../2026-10-01', '2026-10-29'])('rejects %s before any store access', async (date) => {
    const store = await InMemoryStore.create({}), head = vi.spyOn(store, 'head');
    expect(await readRingDay(deps(store), date)).toMatchObject({ code: 'invalid' }); expect(head).not.toHaveBeenCalled();
  });
  it.each(['sha', 'missing', 'size', 'utf8', 'adapter', 'parse'])('rejects %s guard failure', async (guard) => {
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: csv('2026-10-01') });
    const read = store.readFile.bind(store);
    vi.spyOn(store, 'readFile').mockImplementation(async (path, revision) => {
      if (guard === 'adapter') throw new FileTooLarge('synthetic');
      const file = (await read(path, revision))!;
      if (guard === 'missing') return null;
      return { ...file, blobSha: guard === 'sha' ? 'bad' : file.blobSha, bytes: guard === 'size' ? new Uint8Array(1048577) : guard === 'utf8' ? new Uint8Array([255]) : guard === 'parse' ? new TextEncoder().encode('bad') : file.bytes };
    });
    expect(await readRingDay(deps(store), '2026-10-01')).toMatchObject({ status: 'unreadable', slots: [] });
  });
  it.each([StoreUnavailable, StoreUnknownOutcome])('maps upstream failure %s', async (Failure) => {
    const store = await InMemoryStore.create({}); vi.spyOn(store, 'head').mockRejectedValue(new Failure('private'));
    expect(await readRingDay(deps(store), '2026-10-01')).toMatchObject({ code: 'upstream-unavailable' });
  });
  it('refuses a malformed daily file on the day route', async () => {
    const store = await InMemoryStore.create({ [HEALTH_VITALS_DAILY_CSV]: 'bad' });
    expect(await readRingDay(deps(store), '2026-10-01')).toMatchObject({ status: 'unreadable' });
  });
});
