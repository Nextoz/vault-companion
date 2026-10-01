import { RADAR_PAPER_HEADER, RadarNoteResponse, RadarResponse, ResearchRadarDecideCommand } from '@vault-companion/contracts';
import { createCommandService, createResearchRadarService, radarPaperId, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';

const ORIGIN = 'https://vc.example.com';
const ACCOUNT = 'a'.repeat(64);
const NOW = new Date('2026-09-30T10:00:00Z');
const AT = '2026-09-30T12:00:00+02:00';
const SOURCE = 'https://example.com/radar-paper';
const TITLE = 'Synthetic radar paper';

afterEach(() => vi.restoreAllMocks());

async function seed() {
  const scoutPath = 'Research/Daily Research Scout/Daily Research Scout - 2026-09-29.md';
  const scout = `---
created: 2026-09-29
status: complete
scout_health: ok
confidence: 0.9
source: synthetic
tags:
  - ai
  - radar
---
## Most relevant items
- ${TITLE}
- ${SOURCE}
- why synthetic 85/100
`;
  return InMemoryStore.create({ [scoutPath]: scout });
}

function makeApp(store: InMemoryStore, wired: boolean) {
  const deps = { store, now: () => NOW, timeZone: 'Europe/Copenhagen' };
  const commands = createCommandService(deps);
  const services = wired ? { ...commands, ...createResearchRadarService(deps) } : commands;
  const logs: unknown[] = [];
  const consoleCalls: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
  const app = createApp({
    appOrigin: ORIGIN,
    log: (record) => logs.push(record),
    verify: async (token) => token === 'good'
      ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT }
      : { ok: false },
    services,
  });
  return { app, logs, consoleCalls };
}

const auth = { 'Cf-Access-Jwt-Assertion': 'good' };

it('radar routes require auth; valid read is parsed and optional service is 404', async () => {
  const store = await seed();
  const head = vi.spyOn(store, 'head');
  expect((await makeApp(store, true).app.request('/api/radar')).status).toBe(401);
  expect((await makeApp(store, true).app.request('/api/radar', { headers: { 'Cf-Access-Jwt-Assertion': 'bad' } })).status).toBe(401);
  expect(head).not.toHaveBeenCalled();

  const valid = await makeApp(store, true).app.request('/api/radar', { headers: auth });
  expect(valid.status).toBe(200);
  expect(valid.headers.get('Cache-Control')).toBe('no-store');
  expect(RadarResponse.parse(await valid.json()).papers[0]).toMatchObject({ title: TITLE, sourceUrl: SOURCE });
  expect((await makeApp(store, false).app.request('/api/radar', { headers: auth })).status).toBe(404);
});

it('maps unreadable Radar decision JSONL and UTF-8 to a typed 400, never a raw 500', async () => {
  const jsonl = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-09.jsonl': 'not-json\n' });
  const jsonlRes = await makeApp(jsonl, true).app.request('/api/radar', { headers: auth });
  expect(jsonlRes.status).toBe(400);
  expect(await jsonlRes.json()).toMatchObject({ code: 'invalid' });

  const utf8 = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-09.jsonl': new Uint8Array([0xff, 0xfe]) });
  const utf8Res = await makeApp(utf8, true).app.request('/api/radar', { headers: auth });
  expect(utf8Res.status).toBe(400);
  expect(await utf8Res.json()).toMatchObject({ code: 'invalid' });
});

it('resolves a Radar note server-side by paper ID and never accepts a raw note path', async () => {
  const store = await seed();
  const paperId = (await radarPaperId(SOURCE))!;
  const { app } = makeApp(store, true);
  const ok = await app.request('/api/radar/read', { headers: { ...auth, [RADAR_PAPER_HEADER]: paperId } });
  expect(ok.status).toBe(200);
  const body = RadarNoteResponse.parse(await ok.json());
  expect(body).toMatchObject({ status: 'ok', path: 'Research/Daily Research Scout/Daily Research Scout - 2026-09-29.md' });
  if (body.status === 'ok') expect(body.markdown).toContain(TITLE);

  const missing = await app.request('/api/radar/read', { headers: { ...auth, [RADAR_PAPER_HEADER]: '0'.repeat(20) } });
  expect(RadarNoteResponse.parse(await missing.json())).toMatchObject({ status: 'refused', code: 'missing' });
  const invalid = await app.request('/api/radar/read', { headers: { ...auth, [RADAR_PAPER_HEADER]: 'not-a-paper' } });
  expect(invalid.status).toBe(400);
  const unsigned = await app.request('/api/radar/read', { headers: { [RADAR_PAPER_HEADER]: paperId } });
  expect(unsigned.status).toBe(401);
});

it('valid Radar decisions write through the real command service with a clean log', async () => {
  const store = await seed();
  const paperId = (await radarPaperId(SOURCE))!;
  const raw = {
    schemaVersion: 1,
    operationId: '22222222-2222-4222-8222-222222222222',
    type: 'ResearchRadarDecide',
    occurredAt: AT,
    baseRevision: store.headCommit,
    payload: {
      paperId,
      decision: 'keep',
      undoes: null,
      card: { title: TITLE, source: SOURCE, topic: 'radar' },
    },
  };
  const { app, logs, consoleCalls } = makeApp(store, true);
  const res = await app.request('/api/radar/decisions', {
    method: 'POST',
    headers: { ...auth, Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json' },
    body: JSON.stringify(raw),
  });
  expect(res.status).toBe(200);
  const receipt = await res.json();
  expect(receipt).toMatchObject({ operationId: raw.operationId, status: 'applied', path: 'Research/Radar/Decisions/2026-09.jsonl' });
  expect(store.text('Research/Radar/Decisions/2026-09.jsonl')).toContain(raw.operationId);
  expect(JSON.stringify([logs, consoleCalls])).not.toContain(TITLE);
  expect(JSON.stringify([logs, consoleCalls])).not.toContain(SOURCE);
});

it('rejects invalid/foreign Radar decision requests before the service runs', async () => {
  const store = await seed();
  const paperId = (await radarPaperId(SOURCE))!;
  const raw = ResearchRadarDecideCommand.parse({
    schemaVersion: 1,
    operationId: '33333333-3333-4333-8333-333333333333',
    type: 'ResearchRadarDecide',
    occurredAt: AT,
    baseRevision: store.headCommit,
    payload: { paperId, decision: 'remove', undoes: null, card: { title: TITLE, source: SOURCE, topic: 'radar' } },
  });
  const { app } = makeApp(store, true);
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request('/api/radar/decisions', {
    method: 'POST',
    headers: { ...auth, Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  expect((await post(raw, { 'Cf-Access-Jwt-Assertion': '' })).status).toBe(401);
  expect((await post(raw, { Origin: 'https://evil.example.com' })).status).toBe(403);
  expect((await post(raw, { 'X-VC-Account': 'b'.repeat(64) })).status).toBe(409);
  expect((await post('{not-json')).status).toBe(400);
  expect((await post({ ...raw, payload: { ...raw.payload, extra: 'x' } })).status).toBe(400);
  expect(store.writeCalls).toBe(0);
});

it('maps a Radar store outage to a retryable 503 and logs no task text', async () => {
  const store = await seed();
  const paperId = (await radarPaperId(SOURCE))!;
  const raw = ResearchRadarDecideCommand.parse({
    schemaVersion: 1,
    operationId: '44444444-4444-4444-8444-444444444444',
    type: 'ResearchRadarDecide',
    occurredAt: AT,
    baseRevision: store.headCommit,
    payload: { paperId, decision: 'remove', undoes: null, card: { title: TITLE, source: SOURCE, topic: 'radar' } },
  });
  vi.spyOn(store, 'listFiles').mockRejectedValue(new StoreUnavailable('down'));
  const { app, logs, consoleCalls } = makeApp(store, true);
  const res = await app.request('/api/radar/decisions', {
    method: 'POST',
    headers: { ...auth, Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json' },
    body: JSON.stringify(raw),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
  expect(JSON.stringify([logs, consoleCalls])).not.toContain(TITLE);
});
