import { describe, expect, it } from 'vitest';
import { buildWriterInput, stateLine, type Brief, type WriterInput } from '@vault-companion/domain';
import { BRIEF_MODEL, createClaudeChat, writeBrief, type ChatOutcome, type ModelChat } from './claude-chat.ts';

// All data synthetic. The sentinel key must never appear in a result.
const KEY = ['claude', 'sentinel', 'key', '123'].join('-');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** A Messages API reply as the SDK receives it (shape from the SDK's `BetaMessage`). */
const message = (content: unknown[], stop_reason = 'end_turn') => json(200, {
  id: 'msg_synthetic', type: 'message', role: 'assistant', model: BRIEF_MODEL, content, stop_reason, stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const okBody = (text: string) => message([{ type: 'thinking', thinking: '', signature: 'synthetic' }, { type: 'text', text }]);

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
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}
function capture(response: () => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body as string) as Record<string, unknown> });
    return response();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('createClaudeChat', () => {
  it('posts the key, model, low effort and the prompt, and returns only the text blocks', async () => {
    const { fetch, calls } = capture(() => okBody('{"dayLine":"hi"}'));
    const client = createClaudeChat({ apiKey: KEY, fetch, baseURL: 'https://api.example.test' });
    await expect(client.chat({ model: BRIEF_MODEL, system: 's', user: 'u' })).resolves.toEqual({ kind: 'ok', text: '{"dayLine":"hi"}' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.test/v1/messages');
    // The SDK picks the credential header itself; the key must travel in one of them and nowhere else.
    expect(calls[0]!.headers.get('x-api-key') ?? calls[0]!.headers.get('authorization')).toContain(KEY);
    expect(JSON.stringify(calls[0]!.body)).not.toContain(KEY);
    expect(calls[0]!.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
    expect(calls[0]!.body).toMatchObject({
      model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'u' }],
      output_config: { effort: 'low' }, fallbacks: 'default',
    });
    // This model rejects sampling parameters, a thinking switch and a forced response format.
    for (const key of ['temperature', 'top_p', 'thinking', 'response_format']) expect(calls[0]!.body).not.toHaveProperty(key);
  });

  it('never throws, never retries and never leaks the key on an API error', async () => {
    for (const status of [400, 401, 429, 500, 529]) {
      const { fetch, calls } = capture(() => json(status, { type: 'error', error: { type: 'api_error', message: `boom ${KEY}` } }));
      const outcome = await createClaudeChat({ apiKey: KEY, fetch }).chat({ model: BRIEF_MODEL, system: 's', user: 'u' });
      expect(outcome).toEqual({ kind: 'error' });
      expect(JSON.stringify(outcome)).not.toContain(KEY);
      expect(calls).toHaveLength(1);
    }
  });

  it('rejects a malformed body, an empty reply, a refusal and a reply cut at max_tokens', async () => {
    const ask = (response: () => Response) => createClaudeChat({ apiKey: KEY, fetch: capture(response).fetch }).chat({ model: BRIEF_MODEL, system: 's', user: 'u' });
    expect(await ask(() => new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }))).toEqual({ kind: 'error' });
    expect(await ask(() => okBody('   '))).toEqual({ kind: 'error' });
    expect(await ask(() => message([]))).toEqual({ kind: 'error' });
    expect(await ask(() => message([{ type: 'text', text: 'partial' }], 'refusal'))).toEqual({ kind: 'error' });
    expect(await ask(() => message([{ type: 'text', text: '{"dayLine":"cut' }], 'max_tokens'))).toEqual({ kind: 'error' });
  });

  it('times out to an error without throwing or leaking the key', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error(KEY))))) as unknown as typeof fetch;
    const client = createClaudeChat({ apiKey: KEY, fetch: hang, timeoutMs: 5 });
    const outcome = await client.chat({ model: BRIEF_MODEL, system: 's', user: 'u' });
    expect(outcome).toEqual({ kind: 'error' });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it('contains a fetch that throws with the key in its message', async () => {
    const thrower = (() => Promise.reject(new Error(`failed with ${KEY}`))) as unknown as typeof fetch;
    const client = createClaudeChat({ apiKey: KEY, fetch: thrower });
    const outcome = await client.chat({ model: BRIEF_MODEL, system: 's', user: 'u' });
    expect(outcome).toEqual({ kind: 'error' });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });
});

function stubChat(outcome: ChatOutcome): { chat: ModelChat; calls: () => number } {
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
