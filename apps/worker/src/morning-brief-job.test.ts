import { describe, expect, it } from 'vitest';
import {
  MORNING_BRIEF_STATUS_PATH,
  MORNING_BRIEF_PATH,
  morningBriefOperationId,
  parseBriefFile,
  serializeBriefFile,
  type BriefFile,
} from '@vault-companion/domain';
import { ScoutStatus } from '@vault-companion/contracts';
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
  unavailableCodes: {},
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
  opts: { cron?: string; now?: string; chat?: ScalewayChat; mailer?: BriefMailer; gather?: (day: string) => Promise<MorningBriefCandidates>; anyHour?: boolean; subrequests?: () => number; budget?: number } = {},
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
    ...(opts.anyHour !== undefined ? { anyHour: opts.anyHour } : {}),
    ...(opts.subrequests ? { subrequests: opts.subrequests } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  });
  return logs;
}

const status = (store: InMemoryStore): ScoutStatus | null => {
  const text = store.text(MORNING_BRIEF_STATUS_PATH);
  return text === null ? null : ScoutStatus.parse(JSON.parse(text));
};

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

  it('runs only in the Copenhagen 06..11 catch-up window', async () => {
    const windowed = [
      [`${DATE}T03:30:05Z`, false],
      [`${DATE}T04:30:05Z`, true],
      [`${DATE}T09:30:05Z`, true],
      [`${DATE}T10:30:05Z`, false],
    ] as const;
    for (const [instant, runs] of windowed) {
      const store = await InMemoryStore.create({});
      const logs = await run(store, { now: instant });
      expect(store.writeCalls).toBe(runs ? 2 : 0);
      expect(logs).toMatchObject(runs ? [{ status: 200 }] : [{ status: 204, errorCode: 'skipped' }]);
    }
  });

  it('BRIEF_ANY_HOUR skips only the hour guard, so an off-window proof run still writes', async () => {
    const offWindow = `${DATE}T03:30:05Z`;
    const guarded = await InMemoryStore.create({});
    await run(guarded, { now: offWindow });
    expect(guarded.writeCalls).toBe(0);

    const proof = await InMemoryStore.create({});
    const logs = await run(proof, { now: offWindow, anyHour: true });
    expect(proof.writeCalls).toBe(2);
    expect(proof.text(MORNING_BRIEF_PATH)).not.toBeNull();
    expect(logs).toMatchObject([{ status: 200 }]);
  });

  it('writes the fallback brief and the status record when no chat is configured', async () => {
    const store = await InMemoryStore.create({});
    const logs = await run(store);
    expect(store.writeCalls).toBe(2);
    const parsed = parseBriefFile(store.text(MORNING_BRIEF_PATH));
    expect(parsed).toMatchObject({ schemaVersion: 1, date: DATE, source: 'fallback', unavailable: [] });
    expect(parsed?.brief.source).toBe('fallback');
    const op = await morningBriefOperationId(DATE);
    const commits = store.commitsWithOp(op);
    expect(commits).toHaveLength(2);
    expect((await store.readCommit(commits[0]!))?.files.map((f) => f.path)).toEqual([MORNING_BRIEF_PATH]);
    expect((await store.readCommit(commits[1]!))?.files.map((f) => f.path)).toEqual([MORNING_BRIEF_STATUS_PATH]);
    expect(logs).toMatchObject([{ status: 200, operationId: await morningBriefOperationId(DATE) }]);
    expect(JSON.stringify(logs)).not.toContain(TODO_TEXT);
    expect(status(store)?.displayName).toBe('Morning Brief');
    expect(status(store)?.runStatus).toBe('degraded');
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
    expect(store.writeCalls).toBe(1);
    expect(logs).toMatchObject([{ status: 204, errorCode: 'already-written' }]);
    expect(status(store)?.runStatus).toBe('success');
  });

  it('refuses an existing unreadable file and does not call the model', async () => {
    const store = await InMemoryStore.create({ [MORNING_BRIEF_PATH]: 'not json' });
    let gathers = 0;
    const logs = await run(store, { gather: async () => { gathers++; return candidates(); } });
    expect(gathers).toBe(0);
    expect(store.writeCalls).toBe(1);
    expect(logs).toMatchObject([{ status: 503, errorCode: 'not-written:unreadable' }]);
    expect(status(store)?.runStatus).toBe('failed');
    expect(status(store)?.lastError).toBe('not-written:unreadable');
  });

  it('a thrown gatherer still writes the failure status record and never puts brief text in it', async () => {
    const store = await InMemoryStore.create({});
    const logs = await run(store, { gather: async () => { throw new Error('SENTINEL-GATHER-TEXT'); } });
    expect(store.writeCalls).toBe(1);
    expect(store.text(MORNING_BRIEF_PATH)).toBeNull();
    expect(status(store)?.runStatus).toBe('failed');
    expect(status(store)?.lastError).toBe('internal');
    expect(JSON.stringify(status(store))).not.toContain(TODO_TEXT);
    expect(JSON.stringify(status(store))).not.toContain('SENTINEL-GATHER-TEXT');
    expect(logs).toMatchObject([{ status: 500, errorCode: 'internal' }]);
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
    expect(store.writeCalls).toBe(2);
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

  it('records the fixed per-reader codes on the committed run, and only codes', async () => {
    const store = await InMemoryStore.create({});
    const logs = await run(store, {
      gather: async () => candidates({
        unavailable: ['calendar', 'mail'],
        unavailableCodes: { calendar: 'google-reauth-needed', mail: 'upstream-unavailable' },
      }),
    });
    expect(logs).toMatchObject([{ status: 200, unavailableCodes: { calendar: 'google-reauth-needed', mail: 'upstream-unavailable' } }]);
    expect(JSON.stringify(logs)).not.toContain(TODO_TEXT);
  });
});
