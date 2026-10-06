// Ask Jev (ADR-0057): service parsing/refusals and the route's fixed-field logging. Every note/question text here is
// synthetic; the tests assert it never reaches a log or a vault write.
import {
  AskJevResponse,
  encodeNoteHeader,
  NOTE_HEADER,
  type AskJevQuestion,
  type NoteReadResponse,
} from '@vault-companion/contracts';
import { createCommandService, createNotesService } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import { createJevService, isJevAllowedPath, JEV_MODEL, type JevServiceDeps } from './jev.ts';
import type { LogRecord } from './log.ts';

const REVISION = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const NOTE_PATH = 'Inbox/Buy seeds - 2026-09-26.md';
const SENTINEL = 'SENTINEL-jev-note-question';
const QUESTIONS: AskJevQuestion[] = [
  { kind: 'yes-no', question: 'Is this plan clear?' },
  { kind: 'choose', question: 'Which order should I use?', options: ['A', 'B'] },
  { kind: 'rate', question: 'How ready is this?', levels: ['Low', 'High'] },
];

const okNote = (path: string, markdown = 'Synthetic note body.\n'): NoteReadResponse => ({
  status: 'ok', revision: REVISION, path, blobSha: BLOB, markdown, frontmatter: '', body: markdown,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const rawAnswers = {
  answers: {
    q1: { type: 'noul', noul: 0.7 },
    q2: { type: 'choice', choice: 'A', probabilities: { A: 0.6, B: 0.4 } },
    q3: { type: 'score', score: 1, probabilities: { Low: 0.2, High: 0.8 } },
  },
};

const service = (fetch: JevServiceDeps['fetch'], over: Partial<JevServiceDeps> = {}) =>
  createJevService({
    readNote: vi.fn(async (path: string) => okNote(path)),
    fetch,
    apiKey: 'synthetic-key',
    ...over,
  });

describe('isJevAllowedPath', () => {
  it.each(['Health/Note.md', 'health/Note.md', 'Journal/Daily/2026-10-01.md', 'journal/note.md'])(
    'refuses %s case-insensitively', (path) => {
      expect(isJevAllowedPath(path)).toBe(false);
    },
  );
  it('keeps normalised Inbox and other notes', () => {
    expect(isJevAllowedPath(NOTE_PATH)).toBe(true);
    expect(isJevAllowedPath('Projects/Plan.md')).toBe(true);
  });
});

describe('askJev service', () => {
  it('maps one yes/no + one choose + one rate to typed answers with probabilities', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(rawAnswers));
    const result = await service(fetch).askJev(NOTE_PATH, QUESTIONS);
    expect(AskJevResponse.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      answers: [
        { kind: 'yes-no', question: 'Is this plan clear?', probability: 0.7 },
        { kind: 'choose', choice: 'A', probabilities: { A: 0.6, B: 0.4 } },
        { kind: 'rate', score: '1', probabilities: { Low: 0.2, High: 0.8 } },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as { model: string; questions: Record<string, unknown> };
    expect(body.model).toBe(JEV_MODEL);
    expect(body.questions.q2).toMatchObject({
      type: 'choice', criteria: { A: 'A', B: 'B', unresolved: 'Evidence is insufficient to decide' },
    });
  });

  it('refuses an excluded path before any outbound fetch', async () => {
    const fetch = vi.fn(async () => json(rawAnswers));
    const result = await service(fetch).askJev('Health/Private.md', QUESTIONS);
    expect(result).toMatchObject({ code: 'jev-excluded-path' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a note over the 100k character budget without truncating', async () => {
    const fetch = vi.fn(async () => json(rawAnswers));
    const result = await service(fetch, {
      readNote: vi.fn(async () => okNote(NOTE_PATH, 'x'.repeat(100_001))),
    }).askJev(NOTE_PATH, QUESTIONS);
    expect(result).toMatchObject({ code: 'note-too-long' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers jev-unavailable when no API key is configured', async () => {
    const fetch = vi.fn(async () => json(rawAnswers));
    const result = await service(fetch, { apiKey: undefined }).askJev(NOTE_PATH, QUESTIONS);
    expect(result).toMatchObject({ code: 'jev-unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers jev-rate-limited when the daily cap is spent', async () => {
    const fetch = vi.fn(async () => json(rawAnswers));
    const result = await service(fetch, { rateLimit: { allow: () => false } }).askJev(NOTE_PATH, QUESTIONS);
    expect(result).toMatchObject({ code: 'jev-rate-limited' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts the TypeSafe call at the timeout and answers typed', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const result = await service(fetch, { timeoutMs: 5 }).askJev(NOTE_PATH, QUESTIONS);
    expect(result).toMatchObject({ code: 'jev-unavailable', message: 'Jev did not answer in time.', retryable: true });
  });

  it('maps a TypeSafe 500 to a typed upstream refusal', async () => {
    const fetch = vi.fn(async () => json({}, 500));
    const result = await service(fetch).askJev(NOTE_PATH, QUESTIONS);
    expect(result).toMatchObject({ code: 'jev-unavailable', retryable: true });
  });

  it('refuses an answer with an unknown type instead of guessing', async () => {
    const fetch = vi.fn(async () => json({ answers: { q1: { type: 'noul', noul: 0.7 } } }));
    const result = await service(fetch).askJev(NOTE_PATH, QUESTIONS);
    expect(result).toMatchObject({ code: 'jev-bad-answer' });
  });

  it('reads through the real notes service and never writes to the vault', async () => {
    const store = await InMemoryStore.create({ [NOTE_PATH]: 'Synthetic note body.\n' });
    const fetch = vi.fn(async () => json({ answers: { q1: { type: 'noul', probability: 0.5 } } }));
    const notes = createNotesService({ store });
    const result = await createJevService({ readNote: notes.readNote, fetch, apiKey: 'synthetic-key' })
      .askJev(NOTE_PATH, [QUESTIONS[0]!]);
    expect(result).toMatchObject({ answers: [{ kind: 'yes-no', probability: 0.5 }] });
    expect(store.writeCalls).toBe(0);
  });
});

describe('POST /api/notes/ask-jev', () => {
  let logs: LogRecord[];
  let printed: unknown[][];

  beforeEach(() => {
    logs = [];
    printed = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs only the operation id, question types and status; never note text, questions, answers or the key', async () => {
    const store = await InMemoryStore.create({ [NOTE_PATH]: 'Synthetic note body.\n' });
    const commands = createCommandService({ store, now: () => new Date('2026-09-27T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
    const services: Services = {
      ...commands,
      askJev: async () => ({ answers: [] }),
    };
    const app = createApp({
      verify: async (token) => token === 'good'
        ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) }
        : { ok: false },
      appOrigin: 'https://vc.example.com',
      services,
      log: (record) => logs.push(record),
      newRequestId: () => 'request-id-1',
    });
    const response = await app.request('/api/notes/ask-jev', {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': 'good',
        Origin: 'https://vc.example.com',
        'X-VC-Request': '1',
        'X-VC-Account': 'a'.repeat(64),
        [NOTE_HEADER]: encodeNoteHeader(NOTE_PATH),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ questions: [{ kind: 'yes-no', question: SENTINEL }] }),
    });
    expect(response.status).toBe(200);
    expect(logs.at(-1)).toMatchObject({
      route: '/api/notes/ask-jev',
      status: 200,
      operationId: 'request-id-1',
      commandType: 'jev:yes-no',
    });
    expect(JSON.stringify(logs) + JSON.stringify(printed)).not.toContain(SENTINEL);
    expect(store.writeCalls).toBe(0);
  });
});
