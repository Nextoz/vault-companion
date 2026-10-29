import { HEALTH_DAILY_CSV as DAILY, phoneSlotsPath } from '@vault-companion/contracts';
import { canWrite, createHealthIngestService, mergePhoneSlotFile, parsePhoneV2, parseVaultPath, PHONE_METRICS, PHONE_SLOT_HEADER, type WriteRequest } from '@vault-companion/domain';
import * as domain from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { createPhoneIngestService } from './phone-ingest.ts';

const TZ = 'Europe/Copenhagen', now = () => new Date('2026-11-02T12:00:00+01:00');
const OCT = phoneSlotsPath('2026-10'), NOV = phoneSlotsPath('2026-11');
const HEADER = 'date,weekday,steps,distance_km,flights,active_kcal,walking_speed_kmh,first_move,last_move,late_steps,early_steps,headphone_min,headphone_db,loud_min,in_bed_h\n';
const start = '2026-11-01T08:00:00+01:00', end = '2026-11-01T08:05:00+01:00';
const source = `SyntheticSource${'Private'}`;
const line = (type = 'Steps', value: string | number = 987, unit = 'count', a = start, b = end, src = source) => [type, a, b, value, unit, src].join('|');
const body = (samples = line(), from = '2026-10-31T00:00:00+01:00') => JSON.stringify({ schemaVersion: 2, from, sentAt: now().toISOString(), samples });
const service = (store: InMemoryStore) => createPhoneIngestService({ store, now, timeZone: TZ });
const seed = () => InMemoryStore.create({ [DAILY]: HEADER });
const digest = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('');

it('golden: maps converted samples through all seven v1 fields and preserves v1 dispatch bytes', async () => {
  const fields = { steps: [987, 'count'], distance: [1.25, 'km'], flights: [3, 'count'], activeEnergy: [42, 'kcal'], walkingSpeed: [3.6, 'km/hr'], headphone: [81, 'dBASPL'], inBed: ['In Bed', ''] } as const;
  const v1: Record<string, unknown> = { schemaVersion: 1, from: '2026-10-31T00:00:00+01:00', sentAt: now().toISOString() };
  const lines = Object.entries(fields).map(([key, [value, unit]]) => {
    v1[key === 'inBed' ? 'sleep' : key] = [start, end, value, unit].join('|');
    // Exercise conversions, while keeping the equivalent v1 values canonical.
    return line(PHONE_METRICS.find((m) => m.key === key)!.typeName, key === 'distance' ? 1250 : key === 'walkingSpeed' ? 1 : value, key === 'distance' ? 'm' : key === 'walkingSpeed' ? 'm/s' : unit);
  });
  const a = await seed(), b = await seed(), c = await seed(), payload = JSON.stringify(v1);
  expect((await createHealthIngestService({ store: a, now, timeZone: TZ }).ingestHealth(payload)).ok).toBe(true);
  expect((await service(b).ingestHealth(body(lines.join('\n')))).ok).toBe(true);
  expect((await service(c).ingestHealth(payload)).ok).toBe(true);
  expect(b.text(DAILY)).toBe(a.text(DAILY)); expect(c.text(DAILY)).toBe(a.text(DAILY));
  expect(a.text(DAILY)).toBe(`${HEADER}2026-11-01,Sun,987,1.25,3,42,3.6,08:00,08:05,0,0,5,81,5,0.1\n`);
});
it('writes oldest month first, with CAS and exact hash trailers; resend makes no commit', async () => {
  const store = await seed(), write = vi.spyOn(store, 'writeFile');
  const payload = body([line(), line('Steps', 20, 'count', '2026-10-31T23:45:00+01:00', '2026-11-01T00:00:00+01:00')].join('\n'));
  expect(await service(store).ingestHealth(payload)).toEqual({ ok: true, slots: 2, months: ['2026-10', '2026-11'], days: ['2026-10-31', '2026-11-01'], commitSha: store.headCommit });
  expect(write.mock.calls.map(([r]) => r.path)).toEqual([OCT, NOV, DAILY]);
  for (const [i, [r]] of write.mock.calls.entries()) {
    const h = await digest(r.path === DAILY ? payload : `${r.path}\n${new TextDecoder().decode(r.bytes)}`);
    expect(r.trailers['Vault-Companion-Op']).toBe(`${r.path === DAILY ? 'health-ingest' : `phone-slots:${i === 0 ? '2026-10' : '2026-11'}`}:${h.slice(0, 32)}`);
    expect(r.trailers['Vault-Companion-Payload']).toBe(h); expect(r.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(r.expect).toBe(r.path === DAILY ? 'regular-file' : 'absent');
  }
  expect(store.text(NOV)?.split('\n')[0]).toBe(PHONE_SLOT_HEADER);
  const head = store.headCommit, count = store.writeCalls;
  expect((await service(store).ingestHealth(payload)).ok).toBe(true);
  expect(store.headCommit).toBe(head); expect(store.writeCalls).toBe(count);
});
it.each(['throw', 'conflict'])('repairs only daily after write 2 fails (%s), sanitizing adapter text', async (fault) => {
  const store = await seed(), original = store.writeFile.bind(store);
  const write = vi.spyOn(store, 'writeFile').mockImplementation(async (r) => {
    if (r.path === DAILY) {
      if (fault === 'throw') throw new Error(`${source} 9876`);
      return { ok: false, reason: 'head-moved' };
    }
    return original(r);
  });
  expect(await service(store).ingestHealth(body())).toEqual({ ok: false, status: 503, error: 'health daily: write unavailable; resend' });
  const phone = store.text(NOV), count = write.mock.calls.length;
  write.mockImplementation(original);
  expect((await service(store).ingestHealth(body())).ok).toBe(true);
  expect(write.mock.calls.slice(count).map(([r]) => r.path)).toEqual([DAILY]); expect(store.text(NOV)).toBe(phone);
});
it.each([body(line('Unknown')), body(''), body(line('Steps', 9876, 'count', start, end, `PulseLoop${source}`))])('passes through typed parser refusals', async (payload) => {
  const store = await seed(), expected = parsePhoneV2(payload, now(), TZ);
  expect(expected.ok).toBe(false); expect(await service(store).ingestHealth(payload)).toEqual(expected); expect(store.writeCalls).toBe(0);
});
it('preflights a wrong later header before writing either month', async () => {
  const store = await InMemoryStore.create({ [DAILY]: HEADER, [NOV]: 'wrong header\n' });
  const payload = body([line(), line('Steps', 20, 'count', '2026-10-31T12:00:00+01:00', '2026-10-31T12:05:00+01:00')].join('\n'));
  expect(await service(store).ingestHealth(payload)).toEqual({ ok: false, status: 409, error: 'phone slots: write refused; resend' });
  expect(store.writeCalls).toBe(0); expect(store.text(OCT)).toBeNull();
});
it.each(['slots', 'daily'])('re-reads the %s plan at a moved CAS commit', async (kind) => {
  const store = await seed(), original = store.writeFile.bind(store); let injected = false;
  const extra = { instant: Date.parse(start), values: { distance_km: 1 } };
  const merged = mergePhoneSlotFile(null, [extra], 1, TZ); if (!merged.ok) throw new Error('synthetic merge');
  vi.spyOn(store, 'writeFile').mockImplementation(async (r: WriteRequest) => {
    if (!injected && r.path === (kind === 'slots' ? NOV : DAILY)) {
      injected = true;
      await store.commitFiles(kind === 'slots' ? { [NOV]: merged.text } : { [DAILY]: `${HEADER}2026-10-30,Fri,1,0,0,0,,,,0,0,0,,0,\n` });
    }
    return original(r);
  });
  expect((await service(store).ingestHealth(body())).ok).toBe(true); expect(injected).toBe(true);
  expect(store.text(kind === 'slots' ? NOV : DAILY)).toContain(kind === 'slots' ? ',987,1,' : '2026-10-30,Fri,1,');
});
it.each([0, 1])('dedupes an applied write after a lost response at write %i', async (index) => {
  const store = await seed(); store.writeFaults.push(...Array.from({ length: index }, () => 'normal' as const), 'apply-then-unknown');
  expect((await service(store).ingestHealth(body())).ok).toBe(true); expect(store.writeCalls).toBe(2);
});
it('replaces sent cells while null cells preserve stored values', async () => {
  const store = await seed();
  expect((await service(store).ingestHealth(body([line(), line('Walking + Running Distance', 1, 'km')].join('\n')))).ok).toBe(true);
  expect((await service(store).ingestHealth(body(line('Steps', 20)))).ok).toBe(true);
  expect(store.text(NOV)).toContain(',20,1,');
});
it('enforces the exact phone allowlist and the service write guard', async () => {
  expect(canWrite(parseVaultPath(NOV)!, 'create')).toBe(true); expect(canWrite(parseVaultPath(NOV)!, 'update')).toBe(true);
  for (const p of [phoneSlotsPath('2026-13'), `${NOV}/x.csv`, 'Health/Data/Phone/other.csv']) expect(parseVaultPath(p)).toBeNull();
  const store = await seed(), guard = vi.spyOn(domain, 'canWrite').mockReturnValue(false);
  try { expect(await service(store).ingestHealth(body())).toMatchObject({ ok: false, status: 409 }); expect(store.writeCalls).toBe(0); }
  finally { guard.mockRestore(); }
});
it.each([new Uint8Array([255]), new Uint8Array(1024 * 1024 + 1)])('refuses unsafe stored phone bytes', async (bytes) => {
  const store = await InMemoryStore.create({ [DAILY]: HEADER, [NOV]: bytes });
  // Isolate the byte guards: a later header refusal must not hide a missing size/encoding check.
  const merge = vi.spyOn(domain, 'mergePhoneSlotFile').mockReturnValue({ ok: true, changed: true, text: `${PHONE_SLOT_HEADER}\n` });
  try { expect(await service(store).ingestHealth(body())).toMatchObject({ ok: false, status: 409 }); expect(store.writeCalls).toBe(0); }
  finally { merge.mockRestore(); }
});
it('route returns v2 success and failures without leaking sentinels or sources to logs/errors', async () => {
  const store = await seed(), log = vi.fn(), consoleLog = vi.spyOn(console, 'log'), consoleError = vi.spyOn(console, 'error');
  const app = createApp({ verify: async () => ({ ok: false }), verifyIngest: async () => ({ ok: true, commonName: 'synthetic' }), appOrigin: 'https://vc.example.com', log,
    services: { ...service(store), readTasks: async () => ({ code: 'upstream-unavailable', message: 'x', retryable: true }), execute: async () => ({ code: 'upstream-unavailable', message: 'x', retryable: true }) } });
  const post = (payload: string) => app.request('/api/health/ingest', { method: 'POST', body: payload });
  try {
    const ok = await post(body()); expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, days: ['2026-11-01'], slots: 1, months: ['2026-11'] });
    expect(log.mock.calls.at(-1)?.[0].commitSha).toBe(store.headCommit);
    // Repair only slots while daily bytes are already correct, then perform a full no-op resend.
    await store.commitFiles({ [NOV]: null }); const count = store.writeCalls;
    expect((await post(body())).status).toBe(200); expect(store.writeCalls).toBe(count + 1);
    const repaired = store.headCommit;
    expect(log.mock.calls.at(-1)?.[0].commitSha).toBe(repaired);
    expect((await post(body())).status).toBe(200); expect(store.headCommit).toBe(repaired);
    expect(log.mock.calls.at(-1)?.[0].commitSha).toBe(repaired);
    const bad = await post(body(line('Steps', 9876, 'count', start, end, `PulseLoop${source}`)));
    expect(bad.status).toBe(422); const error = await bad.json(); expect(error).toEqual({ ok: false, error: 'line 1 Steps source' });
    const observed = JSON.stringify([log.mock.calls, consoleLog.mock.calls, consoleError.mock.calls, error]);
    for (const secret of ['987', '9876', source, 'PulseLoop']) expect(observed).not.toContain(secret);
  } finally { consoleLog.mockRestore(); consoleError.mockRestore(); }
});
it('maximal three-day synthetic body with every registry type stays within a generous CPU bound', async () => {
  const from = Date.parse('2026-10-30T00:00:00+01:00'), lines: string[] = [];
  for (const metric of PHONE_METRICS) {
    const interval = ['steps', 'distance', 'activeEnergy'].includes(metric.key) ? 5 : 60;
    for (let minute = 60; minute < 3 * 1440; minute += interval) {
      const a = new Date(from + minute * 60000).toISOString(), b = new Date(from + (minute + 1) * 60000).toISOString();
      lines.push(line(metric.typeName, 'category' in metric ? metric.category : 1, Object.keys(metric.units)[0]!, a, b));
    }
  }
  const payload = body(lines.join('\n'), new Date(from).toISOString()), times: number[] = [];
  for (let i = 0; i < 6; i++) {
    const store = await seed(), t = performance.now(), result = await service(store).ingestHealth(payload);
    const elapsed = performance.now() - t;
    expect(result).toMatchObject({ ok: true, months: ['2026-10', '2026-11'] }); expect(store.writeCalls).toBe(3);
    if (i) times.push(elapsed);
  }
  const median = times.sort((a, b) => a - b)[2]!;
  console.info(`phone ingest median warm ms: ${median.toFixed(1)}`); expect(median).toBeLessThan(3000);
}, 30000);
