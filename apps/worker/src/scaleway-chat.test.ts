import { describe, expect, it } from 'vitest';
import { buildWriterInput, stateLine, type Brief, type WriterInput } from '@vault-companion/domain';
import { BRIEF_MODEL, createScalewayChat, writeBrief, type ChatOutcome, type ScalewayChat } from './scaleway-chat.ts';

// All data synthetic. The sentinel key must never appear in a result.
const KEY = ['scw', 'sentinel', 'key', '123'].join('-');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const okBody = (content: string) => json(200, { choices: [{ message: { content } }] });

const DAY = '2026-06-15';
const input = (): WriterInput =>
  buildWriterInput({
    day: DAY,
    blocks: [
      { start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T07:00:00.000Z', minutes: 120, long: true },
      { start: '2026-06-15T07:00:00.000Z', end: '2026-06-15T07:10:00.000Z', minutes: 10, long: false },
    ],
    todos: [{ text: 'SENTINEL-TODO-A', due: DAY, bill: false }],
    state: stateLine([], { mood: -3, energy: -1, sleep: 6 }),
    weatherWindows: [],
    trainingRecent: { count: 0, dates: [] },
    unavailable: [],
  });

const DRAFT = {
  dayLine: 'A quiet day ahead.',
  gaps: [{ blockIndex: 0, suggestion: 'Use the long block.' }],
  todos: [{ id: 0, firstStep: 'Start small.' }],
  encouragement: 'You can take it slowly.',
};

interface Call {
  readonly url: string;
  readonly auth: string | null;
  readonly body: { model: string; temperature: number; response_format: unknown; messages: { role: string; content: string }[] };
}
function capture(response: Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      auth: new Headers(init.headers).get('authorization'),
      body: JSON.parse(init.body as string) as Call['body'],
    });
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('createScalewayChat', () => {
  it('posts bearer auth, model, json_object and returns the content', async () => {
    const { fetch, calls } = capture(okBody('{"dayLine":"hi"}'));
    const client = createScalewayChat({ apiKey: KEY, fetch, apiBase: 'https://api.example.test' });
    await expect(client.chat({ model: BRIEF_MODEL, system: 's', user: 'u' })).resolves.toEqual({ kind: 'ok', text: '{"dayLine":"hi"}' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.test/v1/chat/completions');
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body.model).toBe(BRIEF_MODEL);
    expect(calls[0]!.body.temperature).toBe(0.3);
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]!.body.messages).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
  });

  it('never throws and never leaks the key on a non-200', async () => {
    const { fetch } = capture(json(500, { error: `boom ${KEY}` }));
    const client = createScalewayChat({ apiKey: KEY, fetch });
    const outcome = await client.chat({ model: BRIEF_MODEL, system: 's', user: 'u' });
    expect(outcome).toEqual({ kind: 'error' });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it('rejects a malformed or empty body', async () => {
    const bad = createScalewayChat({ apiKey: KEY, fetch: capture(new Response('not json', { status: 200 })).fetch });
    expect(await bad.chat({ model: BRIEF_MODEL, system: 's', user: 'u' })).toEqual({ kind: 'error' });
    const empty = createScalewayChat({ apiKey: KEY, fetch: capture(okBody('   ')).fetch });
    expect(await empty.chat({ model: BRIEF_MODEL, system: 's', user: 'u' })).toEqual({ kind: 'error' });
    const none = createScalewayChat({ apiKey: KEY, fetch: capture(json(200, { choices: [] })).fetch });
    expect(await none.chat({ model: BRIEF_MODEL, system: 's', user: 'u' })).toEqual({ kind: 'error' });
  });

  it('times out to an error without throwing or leaking the key', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error(KEY))))) as unknown as typeof fetch;
    const client = createScalewayChat({ apiKey: KEY, fetch: hang, timeoutMs: 5 });
    const outcome = await client.chat({ model: BRIEF_MODEL, system: 's', user: 'u' });
    expect(outcome).toEqual({ kind: 'error' });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it('contains a fetch that throws with the key in its message', async () => {
    const thrower = (() => Promise.reject(new Error(`failed with ${KEY}`))) as unknown as typeof fetch;
    const client = createScalewayChat({ apiKey: KEY, fetch: thrower });
    const outcome = await client.chat({ model: BRIEF_MODEL, system: 's', user: 'u' });
    expect(outcome).toEqual({ kind: 'error' });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });
});

function stubChat(outcome: ChatOutcome): { chat: ScalewayChat; calls: () => number } {
  let calls = 0;
  return { chat: { chat: async () => { calls += 1; return outcome; } }, calls: () => calls };
}

describe('writeBrief', () => {
  it('phrases the model reply and marks it as the model source', async () => {
    const { chat } = stubChat({ kind: 'ok', text: JSON.stringify(DRAFT) });
    const brief: Brief = await writeBrief(input(), chat);
    expect(brief.source).toBe('model');
    expect(brief.gaps).toEqual([{ blockIndex: 0, start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T07:00:00.000Z', suggestion: 'Use the long block.' }]);
    expect(brief.todos[0]).toMatchObject({ id: 0, text: 'SENTINEL-TODO-A', firstStep: 'Start small.' });
  });

  it('falls back on a chat error, one attempt only', async () => {
    const { chat, calls } = stubChat({ kind: 'error' });
    const brief = await writeBrief(input(), chat);
    expect(brief.source).toBe('fallback');
    expect(calls()).toBe(1);
  });

  it('falls back when the model reply references nothing valid, one attempt only', async () => {
    const { chat, calls } = stubChat({ kind: 'ok', text: JSON.stringify({ ...DRAFT, todos: [{ id: 9, firstStep: 'x' }], gaps: [{ blockIndex: 1, suggestion: 'y' }] }) });
    const brief = await writeBrief(input(), chat);
    expect(brief.source).toBe('fallback');
    expect(calls()).toBe(1);
  });
});
