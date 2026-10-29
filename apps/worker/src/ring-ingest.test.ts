import { HEALTH_DAILY_CSV, HEALTH_VITALS_DAILY_CSV as DAILY, ringSlotsPath } from '@vault-companion/contracts';
import { canWrite, createHealthIngestService, mergeSlotFile, parseRingPayload, parseSlotFile, parseVaultPath, RING_METRICS, type WriteRequest } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import * as domain from '@vault-companion/domain';
import { expect, it, vi } from 'vitest';
import { createRingIngestService } from './ring-ingest.ts';

const TZ = 'Europe/Copenhagen', now = () => new Date('2026-11-02T12:00:00+01:00');
const OCT = ringSlotsPath('2026-10'), NOV = ringSlotsPath('2026-11');
const slot = (start = '2026-11-01T01:00:00+01:00', values = {}) => ({ start, ...Object.fromEntries(RING_METRICS.map((m) => [m.key, null])), hr: 60, sleepLightMin: 15, ...values });
const body = (slots = [slot('2026-10-31T23:45:00+01:00'), slot()]) => JSON.stringify({ schema: 'ring-slots/1', device: 'synthetic', generatedAt: now().toISOString(), slots });
const service = (store: InMemoryStore) => createRingIngestService({ store, now, timeZone: TZ });
const csv = (payload: string) => {
  const p = parseRingPayload(payload, now(), TZ);
  if (!p.ok) throw new Error('test payload');
  const m = mergeSlotFile(null, p.slots, p.version, TZ);
  if (!m.ok) throw new Error('test merge');
  return m.text;
};

it('creates both months oldest first then daily; exact retry writes nothing; trailers contain hashes only', async () => {
  const store = await InMemoryStore.create({}), write = vi.spyOn(store, 'writeFile');
  expect(await service(store).ingestRing(body())).toEqual({ ok: true, slots: 2, months: ['2026-10', '2026-11'], days: ['2026-10-31', '2026-11-01'] });
  expect(write.mock.calls.map(([r]) => r.path)).toEqual([OCT, NOV, DAILY]);
  for (const [r] of write.mock.calls) {
    expect(r.expect).toBe('absent');
    expect(r.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${r.path}\n${new TextDecoder().decode(r.bytes)}`))), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(r.trailers['Vault-Companion-Op']).toBe(`${r.path === DAILY ? 'ring-daily' : `ring-slots:${r.path === OCT ? '2026-10' : '2026-11'}`}:${digest.slice(0, 32)}`);
    expect(r.trailers['Vault-Companion-Payload']).toBe(digest);
  }
  expect(store.text(DAILY)).toContain('2026-10-31,Sat,2026-10-31T23:45:00+01:00,2026-11-01T01:15:00+01:00,30');
  const head = store.headCommit;
  expect((await service(store).ingestRing(body())).ok).toBe(true);
  expect(store.headCommit).toBe(head); expect(store.writeCalls).toBe(3);
});
it('leaves a V1 daily resend uncommitted and upgrades only a changing send', async () => {
  const payload = body([slot('2026-11-01T12:00:00+01:00', { sleepLightMin: null })]);
  const daily = `${domain.RING_DAILY_HEADER_V1}\n2026-11-01,Sun,,,,,,,60,,,,,1,0,0,0,0\n`;
  const store = await InMemoryStore.create({ [NOV]: csv(payload), [DAILY]: daily });
  const head = store.headCommit;
  expect((await service(store).ingestRing(payload)).ok).toBe(true);
  expect(store.text(DAILY)).toBe(daily);
  expect(store.headCommit).toBe(head); expect(store.writeCalls).toBe(0);
  expect((await service(store).ingestRing(body([slot('2026-11-01T12:00:00+01:00', { hr: 72, sleepLightMin: null })]))).ok).toBe(true);
  expect(store.text(DAILY)).toBe(`${domain.RING_DAILY_HEADER}\n2026-11-01,Sun,,,,,,,72,,,,,1,0,0,0,0,1,720,${'-'.repeat(48)}0${'-'.repeat(47)}\n`);
  expect(store.writeCalls).toBe(2);
});
it.each([2, 3])('repairs only missing writes after write %i fails', async (failAt) => {
  const store = await InMemoryStore.create({}), write = vi.spyOn(store, 'writeFile');
  store.writeFaults.push(...Array.from({ length: failAt - 1 }, () => 'normal' as const), 'unavailable');
  expect(await service(store).ingestRing(body())).toEqual({ ok: false, status: 503, error: `${failAt === 2 ? 'ring slots' : 'ring daily'}: write unavailable; resend` });
  const count = write.mock.calls.length;
  expect((await service(store).ingestRing(body())).ok).toBe(true);
  expect(write.mock.calls.slice(count).map(([r]) => r.path)).toEqual(failAt === 2 ? [NOV, DAILY] : [DAILY]);
});
it('null never erases end to end, and a prior affected date reads its own month', async () => {
  const store = await InMemoryStore.create({ [OCT]: csv(body([slot('2026-10-31T12:00:00+01:00', { hr: 72 })])) });
  const run = service(store);
  await run.ingestRing(body([slot()]));
  expect(store.text(DAILY)).toContain(',72,'); // previous month calendar HR, even though only November was sent
  await run.ingestRing(body([slot(undefined, { hr: null, spo2: 95 })]));
  const parsed = parseSlotFile(store.text(NOV)!);
  expect(parsed.ok && parsed.slots[0]?.values.hr).toBe(60);
  expect(store.text(DAILY)).toContain(',60,95,95,');
});
it.each(['slots', 'daily'])('re-merges %s at each CAS commit and preserves concurrent values', async (kind) => {
  const store = await InMemoryStore.create({}), original = store.writeFile.bind(store);
  let injected = false;
  vi.spyOn(store, 'writeFile').mockImplementation(async (r: WriteRequest) => {
    if (!injected && r.path === (kind === 'slots' ? NOV : DAILY)) {
      injected = true;
      await store.commitFiles({ [NOV]: csv(body([slot(undefined, { hr: 72, spo2: 95 })])) });
    }
    return original(r);
  });
  expect((await service(store).ingestRing(body([slot(undefined, { hr: null, spo2: 95 })]))).ok).toBe(true);
  expect(store.text(DAILY)).toContain(',72,95,95,');
});
it('dedupes a write with a lost response before trying another write', async () => {
  const store = await InMemoryStore.create({}); store.writeFaults.push('apply-then-unknown');
  expect((await service(store).ingestRing(body())).ok).toBe(true); expect(store.writeCalls).toBe(3);
});
it.each([OCT, DAILY])('refuses a malformed stored file at %s without overwriting it', async (path) => {
  const store = await InMemoryStore.create({ [path]: 'wrong header\n' });
  expect(await service(store).ingestRing(body())).toMatchObject({ ok: false, status: 409 });
  expect(store.text(path)).toBe('wrong header\n');
});
it('allows only exact ring CSV targets and makes an empty send a no-op', async () => {
  for (const p of [OCT, DAILY]) for (const k of ['create', 'update'] as const) expect(canWrite(parseVaultPath(p)!, k)).toBe(true);
  for (const p of [ringSlotsPath('2026-13'), `${OCT}/x.csv`, 'Health/Data/Ring/other.csv']) expect(parseVaultPath(p)).toBeNull();
  const store = await InMemoryStore.create({});
  expect(await service(store).ingestRing(body([]))).toEqual({ ok: true, slots: 0, months: [], days: [] }); expect(store.writeCalls).toBe(0);
});
it('keeps the v1 golden output unchanged', async () => {
  const header = 'date,weekday,steps,distance_km,flights,active_kcal,walking_speed_kmh,first_move,last_move,late_steps,early_steps,headphone_min,headphone_db,loud_min,in_bed_h\n';
  const store = await InMemoryStore.create({ [HEALTH_DAILY_CSV]: header });
  const result = await createHealthIngestService({ store, now, timeZone: TZ }).ingestHealth(JSON.stringify({ schemaVersion: 1, from: '2026-11-01T00:00:00+01:00', sentAt: '2026-11-01T10:00:00+01:00', steps: '2026-11-01T08:00:00+01:00|2026-11-01T09:00:00+01:00|620|count', distance: '', flights: '', activeEnergy: '', walkingSpeed: '', headphone: '', sleep: '' }));
  expect(result.ok).toBe(true);
  expect(store.text(HEALTH_DAILY_CSV)).toBe(`${header}2026-11-01,Sun,620,0,0,0,,08:00,09:00,0,0,0,,0,\n`);
});
it('refuses before writing when the write allowlist denies the target', async () => {
  const store = await InMemoryStore.create({}), guard = vi.spyOn(domain, 'canWrite').mockReturnValue(false);
  try { expect(await service(store).ingestRing(body())).toMatchObject({ ok: false, status: 409 }); expect(store.writeCalls).toBe(0); }
  finally { guard.mockRestore(); }
});
it.each([new Uint8Array([0xff]), new Uint8Array(1024 * 1024 + 1)])('refuses unsafe stored bytes without writing', async (bytes) => {
  const store = await InMemoryStore.create({ [NOV]: bytes });
  expect(await service(store).ingestRing(body([slot()]))).toMatchObject({ ok: false, status: 409 }); expect(store.writeCalls).toBe(0);
});

it('computes each slot and daily plan once per revision, recomputing after CAS changes', async () => {
  const concurrent = csv(body([slot('2026-10-31T12:00:00+01:00')]));
  const store = await InMemoryStore.create({}), original = store.writeFile.bind(store);
  const slots = vi.spyOn(domain, 'mergeSlotFile'), daily = vi.spyOn(domain, 'deriveRingDaily');
  let injected = false;
  vi.spyOn(store, 'writeFile').mockImplementation(async (request: WriteRequest) => {
    if (!injected && request.path === NOV) { injected = true; await store.commitFiles({ [OCT]: concurrent }); }
    return original(request);
  });
  try {
    expect((await service(store).ingestRing(body([slot()]))).ok).toBe(true);
    expect(slots).toHaveBeenCalledTimes(2);
    expect(daily).toHaveBeenCalledTimes(1);
  } finally { slots.mockRestore(); daily.mockRestore(); }
});
it('daily validates only rows in the needed canonical local dates', async () => {
  const old = csv(body([slot('2026-10-31T12:00:00+01:00')])).split('\n');
  old[1] = old[1]!.replace('2026-10-31', '2026-10-01').replace(',60,', ',NaN,');
  const store = await InMemoryStore.create({ [OCT]: old.join('\n') });
  expect((await service(store).ingestRing(body([slot()]))).ok).toBe(true);
  const nearby = await InMemoryStore.create({ [OCT]: old.join('\n').replace('2026-10-01', '2026-10-31') });
  expect(await service(nearby).ingestRing(body([slot()]))).toMatchObject({ ok: false, status: 409 });
});

it('refuses daily derivation when its date window does not converge within sixteen passes', async () => {
  const store = await InMemoryStore.create({});
  let call = 0;
  // Eventually converge even without the guard, so removing it fails the assertion without hanging the test.
  const affected = vi.spyOn(domain, 'affectedDates').mockImplementation(() => [
    new Date(Date.parse('2026-11-01T12:00:00Z') + Math.min(call++, 17) * 3 * 86400000).toISOString().slice(0, 10),
  ]);
  try {
    expect(await service(store).ingestRing(body([slot()]))).toEqual({ ok: false, status: 409, error: 'ring daily: write refused; resend' });
    expect(affected).toHaveBeenCalledTimes(17);
    expect(store.text(DAILY)).toBeNull();
  } finally { affected.mockRestore(); }
});
