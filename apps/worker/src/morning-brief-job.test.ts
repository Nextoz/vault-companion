import { describe, expect, it } from 'vitest';
import {
  MORNING_BRIEF_PATH,
  morningBriefOperationId,
  parseBriefFile,
  serializeBriefFile,
  TRAILER_OP,
  type BriefFile,
} from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import type { LogRecord } from './log.ts';
import type { MorningBriefCandidates } from './morning-brief-gather.ts';
import type { BriefEmail, BriefMailer } from './morning-brief-email.ts';
import { BRIEF_CRONS, runBriefJob } from './morning-brief-job.ts';
import type { ScalewayChat } from './scaleway-chat.ts';

const DATE = '2026-06-15';
const NOW = `${DATE}T04:30:05Z`;
const TZ = 'Europe/Copenhagen';
const TODO_TEXT = 'SENTINEL-CANDIDATE-TODO';

const candidates = (over: Partial<MorningBriefCandidates> = {}): MorningBriefCandidates => ({
  todos: [{ text: TODO_TEXT, due: DATE, bill: false }],
  events: [],
  metrics: [],
  mood: { mood: -1, energy: 0, sleep: 7 },
  trainingRecent: { count: 0, dates: [] },
  weatherWindows: [],
  unavailable: [],
  ...over,
});

const seedFile: BriefFile = {
  schemaVersion: 1,
  date: DATE,
  generatedAt: NOW,
  source: 'fallback',
  unavailable: ['mail'],
  brief: {
    source: 'fallback',
    dayLine: `${DATE}: 0 free block(s), 0 todo candidate(s).`,
    gaps: [],
    todos: [],
  },
};

const modelChat: ScalewayChat = {
  chat: async () => ({
    kind: 'ok',
    text: JSON.stringify({
      dayLine: 'A short day with room to breathe.',
      gaps: [],
      todos: [{ id: 0, firstStep: 'Open the letter.' }],
      encouragement: 'One step is enough.',
    }),
  }),
};

async function run(
  store: InMemoryStore,
  opts: { cron?: string; now?: string; chat?: ScalewayChat; mailer?: BriefMailer; gather?: (day: string) => Promise<MorningBriefCandidates> } = {},
) {
  const logs: LogRecord[] = [];
  await runBriefJob(opts.cron ?? BRIEF_CRONS.summer, {
    store,
    gather: opts.gather ?? (async () => candidates()),
    ...(opts.chat ? { chat: opts.chat } : {}),
    ...(opts.mailer ? { mailer: opts.mailer } : {}),
    now: () => new Date(opts.now ?? NOW),
    timeZone: TZ,
    log: (r) => logs.push(r),
  });
  return logs;
}

function spyMailer(): { mailer: BriefMailer; sent: BriefEmail[] } {
  const sent: BriefEmail[] = [];
  return { mailer: { send: async (message) => { sent.push(message); } }, sent };
}

describe('morning brief job (ADR-0046)', () => {
  it('a non-06 Copenhagen hour skips before any read, model call, or write', async () => {
    const store = await InMemoryStore.create({});
    const logs = await run(store, { now: `${DATE}T03:30:05Z` });
    expect(store.calls).toEqual([]);
    expect(store.writeCalls).toBe(0);
    expect(store.text(MORNING_BRIEF_PATH)).toBeNull();
    expect(logs).toMatchObject([{ route: 'cron:morning-brief', status: 204, errorCode: 'skipped' }]);
  });

  it('writes exactly the one JSON file with the fallback brief when no chat is configured', async () => {
    const store = await InMemoryStore.create({});
    const logs = await run(store);
    expect(store.writeCalls).toBe(1);
    const parsed = parseBriefFile(store.text(MORNING_BRIEF_PATH));
    expect(parsed).toMatchObject({ schemaVersion: 1, date: DATE, source: 'fallback', unavailable: [] });
    expect(parsed?.brief.source).toBe('fallback');
    const commit = await store.readCommit(store.headCommit);
    expect(commit?.files.map((f) => f.path)).toEqual([MORNING_BRIEF_PATH]);
    expect(commit?.trailers[TRAILER_OP]).toBe(await morningBriefOperationId(DATE));
    expect(logs).toMatchObject([{ status: 200, operationId: await morningBriefOperationId(DATE) }]);
    expect(JSON.stringify(logs)).not.toContain(TODO_TEXT);
  });

  it('writes the model brief when the chat returns a valid reply', async () => {
    const store = await InMemoryStore.create({});
    const logs = await run(store, { chat: modelChat });
    const parsed = parseBriefFile(store.text(MORNING_BRIEF_PATH));
    expect(parsed?.source).toBe('model');
    expect(parsed?.brief.todos[0]).toMatchObject({ id: 0, text: TODO_TEXT, firstStep: 'Open the letter.' });
    expect(logs).toMatchObject([{ status: 200 }]);
  });

  it('passes real free blocks from calendar events and never hard-codes calendar/mail unavailability', async () => {
    const store = await InMemoryStore.create({});
    const event = { title: 'Focus block', start: '2026-06-15T10:00:00.000Z', end: '2026-06-15T11:00:00.000Z', allDay: false };
    const logs = await run(store, {
      gather: async () => candidates({ events: [event], unavailable: ['calendar'] }),
    });
    const parsed = parseBriefFile(store.text(MORNING_BRIEF_PATH));
    expect(parsed?.brief.gaps.length).toBeGreaterThan(0);
    expect(parsed?.unavailable).toEqual(['calendar']);
    expect(JSON.stringify(logs)).not.toContain('mail');
  });

  it('falls back when the model output is invalid and never writes model text', async () => {
    const junk = 'SENTINEL-MODEL-JUNK';
    const store = await InMemoryStore.create({});
    const logs = await run(store, { chat: { chat: async () => ({ kind: 'ok', text: junk }) } });
    const parsed = parseBriefFile(store.text(MORNING_BRIEF_PATH));
    expect(parsed?.source).toBe('fallback');
    expect(parsed?.brief.source).toBe('fallback');
    expect(store.text(MORNING_BRIEF_PATH)).not.toContain(junk);
    expect(JSON.stringify(logs)).not.toContain(junk);
  });

  it('does nothing when today is already written (second cron/retry dedupe)', async () => {
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: serializeBriefFile(seedFile) });
    let gathers = 0;
    const logs = await run(store, { gather: async () => { gathers++; return candidates(); } });
    expect(gathers).toBe(0);
    expect(store.writeCalls).toBe(0);
    expect(logs).toMatchObject([{ status: 204, errorCode: 'already-written' }]);
  });

  it('refuses an existing unreadable file and does not call the model', async () => {
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: 'not json' });
    let gathers = 0;
    const logs = await run(store, { gather: async () => { gathers++; return candidates(); } });
    expect(gathers).toBe(0);
    expect(store.writeCalls).toBe(0);
    expect(logs).toMatchObject([{ status: 503, errorCode: 'not-written:unreadable' }]);
  });

  it('a CAS conflict is a typed outcome and never overwrites', async () => {
    const store = await InMemoryStore.create({});
    const head = store.headCommit;
    const submitted: { baseCommit: string; expect: 'absent' | 'regular-file'; path: string }[] = [];
    store.writeFile = async (req) => {
      submitted.push({ baseCommit: req.baseCommit, expect: req.expect, path: req.path });
      return { ok: false, reason: 'precondition-failed' };
    };
    const logs = await run(store);
    expect(submitted).toEqual([{ baseCommit: head, expect: 'absent', path: MORNING_BRIEF_PATH }]);
    expect(store.text(MORNING_BRIEF_PATH)).toBeNull();
    expect(logs).toMatchObject([{ status: 503, errorCode: 'not-written:precondition-failed' }]);
  });

  it('an unknown cron does nothing', async () => {
    const store = await InMemoryStore.create({});
    const logs = await run(store, { cron: '0 0 * * *' });
    expect(store.calls).toEqual([]);
    expect(store.writeCalls).toBe(0);
    expect(logs).toMatchObject([{ status: 400, errorCode: 'unknown-cron' }]);
  });

  it('emails the committed brief exactly once with the date subject and the brief body', async () => {
    const store = await InMemoryStore.create({});
    const { mailer, sent } = spyMailer();
    const logs = await run(store, { mailer });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(`Morning Brief - ${DATE}`);
    expect(sent[0]!.text).toContain(`${DATE}: 1 free block(s), 1 todo candidate(s).`);
    expect(logs).toMatchObject([{ status: 200, operationId: await morningBriefOperationId(DATE) }]);
  });

  it('never emails on already-written, skipped, or not-written runs', async () => {
    const already = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: serializeBriefFile(seedFile) });
    const existing = spyMailer();
    await run(already, { mailer: existing.mailer });
    expect(existing.sent).toEqual([]);

    const skipped = await InMemoryStore.create({});
    const early = spyMailer();
    await run(skipped, { mailer: early.mailer, now: `${DATE}T03:30:05Z` });
    expect(early.sent).toEqual([]);

    const conflict = await InMemoryStore.create({});
    conflict.writeFile = async () => ({ ok: false, reason: 'precondition-failed' });
    const refused = spyMailer();
    await run(conflict, { mailer: refused.mailer });
    expect(refused.sent).toEqual([]);
  });

  it('keeps the commit when the email send throws and logs only email-failed', async () => {
    const store = await InMemoryStore.create({});
    const boom = 'BOOM-BODY-TEXT';
    const mailer: BriefMailer = { send: async () => { throw new Error(boom); } };
    const logs = await run(store, { mailer });
    expect(store.writeCalls).toBe(1);
    expect(store.text(MORNING_BRIEF_PATH)).not.toBeNull();
    expect(logs).toMatchObject([
      { status: 200, operationId: await morningBriefOperationId(DATE) },
      { status: 200, errorCode: 'email-failed' },
    ]);
    expect(JSON.stringify(logs)).not.toContain(boom);
  });

  it('never puts the email subject, body, or candidate text in the log', async () => {
    const store = await InMemoryStore.create({});
    const { mailer, sent } = spyMailer();
    const logs = await run(store, { mailer });
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(sent[0]!.subject);
    expect(logged).not.toContain('free block(s)');
    expect(logged).not.toContain(TODO_TEXT);
  });
});
