// Scaleway Generative APIs chat client (ADR-0045): EU-hosted model used to phrase the Morning Brief. Only the outcome
// class leaves this file — never the key, the prompt, or the model's text in an error or a log. The client never
// throws; any non-200, timeout, empty or malformed body is a typed error the caller turns into the fallback brief.
// API shape followed: https://www.scaleway.com/en/docs/generative-apis/reference-content/chat-completions (OpenAI-like).
import { buildWriterPrompt, fallbackBrief, parseWriterOutput, toBrief, type Brief, type WriterInput } from '@vault-companion/domain';

export const BRIEF_MODEL = 'deepseek-v4-flash-0731';
export const SCALEWAY_TIMEOUT_MS = 60_000;
const DEFAULT_API_BASE = 'https://api.scaleway.ai';

export type ChatOutcome = { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'error' };

export interface ChatRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
}

export interface ScalewayChat {
  chat(request: ChatRequest): Promise<ChatOutcome>;
}

export interface ScalewayChatOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
  readonly timeoutMs?: number;
}

interface ChatBody {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[];
}

export function createScalewayChat(opts: ScalewayChatOptions): ScalewayChat {
  // Bound: Workers throw "Illegal invocation" when the global fetch is called as a method of another object.
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.apiBase ?? DEFAULT_API_BASE;
  const timeoutMs = opts.timeoutMs ?? SCALEWAY_TIMEOUT_MS;
  return {
    async chat({ model, system, user }): Promise<ChatOutcome> {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await f(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: abort.signal,
        });
        if (res.status !== 200) return { kind: 'error' };
        const body = (await res.json()) as ChatBody;
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) return { kind: 'error' };
        return { kind: 'ok', text: content };
      } catch {
        return { kind: 'error' }; // network error, timeout, or a malformed body
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One attempt: ask the model, validate its reply, and fall back to the deterministic brief on any failure. */
export async function writeBrief(input: WriterInput, chat: ScalewayChat): Promise<Brief> {
  const { system, user } = buildWriterPrompt(input);
  const outcome = await chat.chat({ model: BRIEF_MODEL, system, user });
  if (outcome.kind !== 'ok') return fallbackBrief(input);
  const draft = parseWriterOutput(outcome.text, input);
  return draft ? toBrief(draft, input) : fallbackBrief(input);
}
