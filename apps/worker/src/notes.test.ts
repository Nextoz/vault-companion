// Inbox notes routes (ADR-0022): GET /api/notes and GET /api/notes/read through createApp + the real services +
// InMemoryStore. Auth, `Cache-Control: no-store`, header-only path, and no note text, title or path in any log.
import { encodeNoteHeader, NOTE_HEADER, NoteReadResponse, NotesResponse } from '@vault-companion/contracts';
import { createCommandService, createNotesService, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-n7q2';
const NOTE = `Inbox/Blåbær ${SENTINEL} - 2026-09-27.md`;
const now = () => new Date('2026-09-27T12:00:00Z');

let logs: LogRecord[];
let printed: unknown[][];

beforeEach(() => {
  logs = [];
  printed = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a));
});
afterEach(() => vi.restoreAllMocks());

function app(store: InMemoryStore, wired = true) {
  const commands = createCommandService({ store, now, timeZone: 'Europe/Copenhagen' });
  const services: Services = wired ? { ...commands, ...createNotesService({ store }) } : commands;
  return createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false }),
    appOrigin: 'https://vc.example.com',
    services,
    log: (r) => logs.push(r),
  });
}
const headers = (extra: Record<string, string> = {}, token = 'good') => ({ 'Cf-Access-Jwt-Assertion': token, ...extra });
const leaked = () => (JSON.stringify(logs) + JSON.stringify(printed)).includes(SENTINEL);
const files = { [NOTE]: `---\ntype: inbox-note\n---\n${SENTINEL} body\n`, 'Inbox/Sub/Nested.md': 'x\n' };

describe('GET /api/notes', () => {
  it('lists Inbox notes, no-store, and logs no title or path', async () => {
    const store = await InMemoryStore.create(files);
    const res = await app(store).request('/api/notes', { headers: headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = NotesResponse.parse(await res.json());
    expect(body.notes.map((n) => n.path)).toEqual([NOTE]);
    expect(logs.at(-1)).toMatchObject({ route: '/api/notes', status: 200, commitSha: store.headCommit });
    expect(leaked()).toBe(false);
  });

  it('requires authentication; unwired ⇒ 404; outage ⇒ 503', async () => {
    const store = await InMemoryStore.create(files);
    expect((await app(store).request('/api/notes', { headers: headers({}, 'bad') })).status).toBe(401);
    expect((await app(store, false).request('/api/notes', { headers: headers() })).status).toBe(404);
    vi.spyOn(store, 'head').mockRejectedValueOnce(new StoreUnavailable('down'));
    const res = await app(store).request('/api/notes', { headers: headers() });
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/notes/read', () => {
  it('reads the note named by the (percent-encoded) header; logs no text or path', async () => {
    const store = await InMemoryStore.create(files);
    const res = await app(store).request('/api/notes/read', { headers: headers({ [NOTE_HEADER]: encodeNoteHeader(NOTE) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = NoteReadResponse.parse(await res.json());
    expect(body).toMatchObject({ status: 'ok', path: NOTE, frontmatter: '---\ntype: inbox-note\n---\n', body: `${SENTINEL} body\n` });
    expect(logs.at(-1)).toMatchObject({ route: '/api/notes/read', status: 200, commitSha: store.headCommit });
    expect(leaked()).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['nested', encodeNoteHeader('Inbox/Sub/Nested.md')],
    ['other root', encodeNoteHeader('Projects/Plan.md')],
    ['traversal', encodeNoteHeader('Inbox/../Tasks/To-Do List.md')],
    ['malformed percent-encoding', '%E0%A4%A'],
    ['not .md', encodeNoteHeader('Inbox/a.txt')],
  ])('invalid header (%s) ⇒ 400 before any store call', async (_, value) => {
    const store = await InMemoryStore.create(files);
    const head = vi.spyOn(store, 'head');
    const res = await app(store).request('/api/notes/read', { headers: headers(value === undefined ? {} : { [NOTE_HEADER]: value }) });
    expect(res.status).toBe(400);
    expect(head).not.toHaveBeenCalled();
  });

  it('a valid but unlisted note is a typed refusal; auth and wiring as elsewhere', async () => {
    const store = await InMemoryStore.create(files);
    const h = { [NOTE_HEADER]: encodeNoteHeader('Inbox/Gone.md') };
    const res = await app(store).request('/api/notes/read', { headers: headers(h) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'refused', code: 'not-found' });
    expect(logs.at(-1)).toMatchObject({ errorCode: 'note:not-found' });
    expect((await app(store).request('/api/notes/read', { headers: headers(h, 'bad') })).status).toBe(401);
    expect((await app(store, false).request('/api/notes/read', { headers: headers(h) })).status).toBe(404);
  });
});
