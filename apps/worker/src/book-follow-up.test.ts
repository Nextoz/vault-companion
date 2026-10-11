import { BookFollowUpResponse, Command, Receipt, type BookFollowUpRequest } from '@vault-companion/contracts';
import { createBooksService, createCommandService } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { BOOK_FOLLOW_UP_SYSTEM, BOOK_FOLLOW_UP_TIMEOUT_MS, createBookFollowUpService } from './book-follow-up.ts';
import type { LogRecord } from './log.ts';
import { createScalewayChat, type ChatOutcome, type ChatRequest } from './scaleway-chat.ts';

const ACCOUNT = 'a'.repeat(64);
const TITLE = 'Synthetic Private Title';
const FIRST = 'SENTINEL-FIRST reflection\nTwo synthetic lines';
const OTHER = 'SENTINEL-OTHER entry';
const QUESTION = 'What would change your view?';
const fixture = `---\ntype: book\nauthor: Synthetic Author\ntotalPages: 100\n---\n# ${TITLE}\n\n## Progress\n\n## Reflections\n### 2026-10-02\n${FIRST}\n\n### 2026-10-03\nDifferent day\n\n### 2026-10-02\n${OTHER}\n`;
const request: BookFollowUpRequest = { title: TITLE, date: '2026-10-02', ordinal: 1 };
const headers = { 'Cf-Access-Jwt-Assertion': 'good', Origin: 'https://vc.example.com', 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json' };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup(outcome: ChatOutcome = { kind: 'ok', text: QUESTION }, configured = true) {
  const store = await InMemoryStore.create({ [`Books/${TITLE}.md`]: fixture });
  const logs: LogRecord[] = [];
  const chat = vi.fn<(request: ChatRequest) => Promise<ChatOutcome>>().mockResolvedValue(outcome);
  let now = Date.parse('2026-10-05T12:00:00Z');
  const service = createBookFollowUpService({ readBooks: createBooksService({ store }).readBooks, ...(configured ? { chat: { chat } } : {}), now: () => now });
  const app = createApp({
    verify: async (token) => token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false },
    appOrigin: headers.Origin,
    services: { ...createCommandService({ store, now: () => new Date(now), timeZone: 'Europe/Copenhagen' }), ...service },
    log: (record) => logs.push(record),
  });
  const post = (body: unknown = request, changes: Record<string, string> = {}) => app.request('/api/books/follow-up', { method: 'POST', headers: { ...headers, ...changes }, body: JSON.stringify(body) });
  return { app, store, chat, logs, post, service, nextDay: () => { now += 86_400_000; } };
}

it('returns a trimmed question, sends ONLY the selected reflection, and never writes or logs private text', async () => {
  const printed: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { printed.push(args); });
  const h = await setup({ kind: 'ok', text: `  ${QUESTION}  ` });
  const head = h.store.headCommit;
  const res = await h.post();
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(BookFollowUpResponse.parse(await res.json())).toEqual({ question: QUESTION });
  expect(h.chat).toHaveBeenCalledExactlyOnceWith({ model: 'glm-5.2', system: BOOK_FOLLOW_UP_SYSTEM, user: FIRST, responseFormat: 'text', timeoutMs: BOOK_FOLLOW_UP_TIMEOUT_MS });
  const prompt = JSON.stringify(h.chat.mock.calls);
  expect(prompt).not.toContain(TITLE);
  expect(prompt).not.toContain(OTHER);
  expect(prompt).not.toContain('Different day');
  expect(BOOK_FOLLOW_UP_SYSTEM).toBe('ask one short follow-up question, one line, in the language of the text');
  expect(h.store.headCommit).toBe(head);
  expect(h.store.writeCalls).toBe(0);
  expect(h.logs.at(-1)).toMatchObject({ route: '/api/books/follow-up', status: 200 });
  expect(h.logs.at(-1)?.operationId).toBeDefined();
  for (const sentinel of [TITLE, FIRST, OTHER, QUESTION]) expect(JSON.stringify(h.logs) + JSON.stringify(printed)).not.toContain(sentinel);
});

it('ordinal 2 means the second reflection of that date, excluding other dates', async () => {
  const h = await setup();
  expect((await h.post({ ...request, ordinal: 2 })).status).toBe(200);
  expect(h.chat.mock.calls[0]![0].user).toBe(OTHER);
});

it('chat error becomes 503 with no retry or provider error text', async () => {
  const h = await setup({ kind: 'error' });
  const res = await h.post();
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: 'follow-up-unavailable', retryable: true });
  expect(h.chat).toHaveBeenCalledTimes(1);
  h.chat.mockRejectedValueOnce(new Error(FIRST));
  const thrown = await h.post();
  expect(thrown.status).toBe(503);
  expect(JSON.stringify(await thrown.json()) + JSON.stringify(h.logs)).not.toContain(FIRST);
});

it.each(['Why?\nHow?', 'Why?\rHow?', 'Why?\u2028How?', 'No question mark', 'x'.repeat(300) + '?', '# Why?', 'C#?', '', '  '])('rejects bad output %# with 502', async (text) => {
  const h = await setup({ kind: 'ok', text });
  const res = await h.post();
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ code: 'follow-up-bad-output', retryable: false });
  expect(h.chat).toHaveBeenCalledTimes(1);
});

it('accepts the 300-character boundary', async () => {
  const h = await setup({ kind: 'ok', text: 'x'.repeat(299) + '?' });
  expect((await h.post()).status).toBe(200);
});

it('caps at five per isolate, returns 429 on sixth, and resets the next day', async () => {
  const h = await setup();
  for (let n = 0; n < 5; n++) expect((await h.post()).status).toBe(200);
  const limited = await h.post();
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ code: 'follow-up-rate-limited', retryable: false });
  expect(h.chat).toHaveBeenCalledTimes(5);
  h.nextDay();
  expect((await h.post()).status).toBe(200);
  expect(h.chat).toHaveBeenCalledTimes(6);
});

it('invalid reflection selections and read failures never consume the cap', async () => {
  const readBooks = vi.fn<ReturnType<typeof createBooksService>['readBooks']>().mockResolvedValue({ status: 'ok', revision: '1'.repeat(40), books: [] });
  const chat = vi.fn<(request: ChatRequest) => Promise<ChatOutcome>>();
  const service = createBookFollowUpService({ readBooks, chat: { chat } });
  for (let n = 0; n < 8; n++) expect(await service.followUp(request)).toMatchObject({ code: 'reflection-not-found' });
  readBooks.mockRejectedValue(new Error('down'));
  for (let n = 0; n < 8; n++) expect(await service.followUp(request)).toMatchObject({ code: 'follow-up-unavailable' });
  expect(chat).not.toHaveBeenCalled();
});

it('passes the 30 s deadline to the chat client so the request itself is aborted', async () => {
  const h = await setup();
  await h.post();
  expect(h.chat.mock.calls[0]![0]).toMatchObject({ timeoutMs: 30_000 });
});

it('returns 503 when no key configures chat', async () => {
  const h = await setup(undefined, false);
  const res = await h.post();
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: 'follow-up-unavailable', retryable: false });
  expect(h.chat).not.toHaveBeenCalled();
});

it.each([{ title: 'Unknown book' }, { date: '2026-10-04' }, { ordinal: 3 }])('returns reflection-not-found without chat for unknown selection %#', async (change) => {
  const h = await setup();
  const res = await h.post({ ...request, ...change });
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ code: 'reflection-not-found', retryable: false });
  expect(h.chat).not.toHaveBeenCalled();
});

it('guards authentication, origin, account, JSON and selection-only body before chat', async () => {
  const h = await setup();
  for (const [change, status] of [
    [{ 'Cf-Access-Jwt-Assertion': 'bad' }, 401], [{ Origin: 'https://evil.example' }, 403],
    [{ 'X-VC-Request': '0' }, 403], [{ 'Content-Type': 'text/plain' }, 403], [{ 'X-VC-Account': 'b'.repeat(64) }, 409],
  ] as const) expect((await h.post(request, change)).status).toBe(status);
  expect((await h.post({ ...request, text: FIRST })).status).toBe(400);
  expect((await h.post({ ...request, ordinal: 0 })).status).toBe(400);
  expect(h.chat).not.toHaveBeenCalled();
});

it('the real Scaleway client sends plain text mode for follow-ups and aborts at 30 seconds', async () => {
  let body: Record<string, unknown> | undefined;
  let aborted = false;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
    body = JSON.parse(init!.body as string) as Record<string, unknown>;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('timeout')); }));
  });
  const h = await setup();
  const service = createBookFollowUpService({ readBooks: createBooksService({ store: h.store }).readBooks, chat: createScalewayChat({ apiKey: 'synthetic-key', fetch, timeoutMs: 60_000 }) });
  vi.useFakeTimers();
  const result = service.followUp(request);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(body).not.toHaveProperty('response_format');
  expect(body).toMatchObject({ model: 'glm-5.2', messages: [{ role: 'system', content: BOOK_FOLLOW_UP_SYSTEM }, { role: 'user', content: FIRST }] });
  await vi.advanceTimersByTimeAsync(BOOK_FOLLOW_UP_TIMEOUT_MS);
  expect(await result).toMatchObject({ code: 'follow-up-unavailable' });
  expect(aborted).toBe(true);
});

it('SaveFollowUp and UndoSaveFollowUp traverse the command route without logging any private text', async () => {
  const h = await setup();
  const answer = 'SENTINEL-ANSWER synthetic text';
  const command = (type: string, payload: unknown, operationId: string) => Command.parse({ schemaVersion: 1, type, payload, operationId, baseRevision: h.store.headCommit, occurredAt: '2026-10-05T12:00:00Z' });
  const post = (body: Command) => h.app.request('/api/commands', { method: 'POST', headers, body: JSON.stringify(body) });
  const target = command('SaveFollowUp', { ...request, question: QUESTION, answer }, '00000000-0000-4000-8000-000000000001');
  const savedResponse = await post(target);
  expect(savedResponse.status).toBe(200);
  const saved = Receipt.parse(await savedResponse.json());
  expect(h.store.text(`Books/${TITLE}.md`)).toBe(fixture.replace(FIRST + '\n', FIRST + `\n\n> AI question: ${QUESTION}\n\n${answer}\n`));
  const undoResponse = await post(command('UndoSaveFollowUp', { target, targetCommit: saved.commitSha }, '00000000-0000-4000-8000-000000000002'));
  expect(undoResponse.status).toBe(200);
  expect(h.store.text(`Books/${TITLE}.md`)).toBe(fixture);
  for (const sentinel of [TITLE, FIRST, OTHER, QUESTION, answer]) expect(JSON.stringify(h.logs)).not.toContain(sentinel);
  expect(h.chat).not.toHaveBeenCalled();
});
