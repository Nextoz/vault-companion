// Claude chat client (ADR-0071, replaces the Scaleway client of ADR-0045): phrases the Morning Brief and asks the
// Reading follow-up question (ADR-0063). Only the outcome class leaves this file — never the key, the prompt, or the
// model's text in an error or a log. The client never throws; any API error, timeout, refusal, cut-off or empty reply
// is a typed error the caller turns into its own fallback.
import Anthropic from '@anthropic-ai/sdk';
import { buildWriterPrompt, fallbackBrief, parseWriterOutput, toBrief, type Brief, type WriterInput } from '@vault-companion/domain';

/** One model for both uses; change it here only (ADR-0071). */
export const CLAUDE_MODEL = 'claude-opus-5-5';
export const BRIEF_MODEL = CLAUDE_MODEL;
export const CLAUDE_TIMEOUT_MS = 60_000;
/** Room for the model's own thinking plus a short reply; both callers validate the length of what comes back. */
const MAX_TOKENS = 16_000;

export type ChatOutcome = { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'error' };

export interface ChatRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** Per-request abort deadline; defaults to the client's. */
  readonly timeoutMs?: number;
}

export interface ModelChat {
  chat(request: ChatRequest): Promise<ChatOutcome>;
}

export interface ClaudeChatOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  readonly timeoutMs?: number;
}

export function createClaudeChat(opts: ClaudeChatOptions): ModelChat {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    // Bound: Workers throw "Illegal invocation" when the global fetch is called as a method of another object.
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    // One attempt: a retry would spend the cron's subrequest budget and the callers already have a fallback.
    maxRetries: 0,
  });
  const timeoutMs = opts.timeoutMs ?? CLAUDE_TIMEOUT_MS;
  return {
    async chat({ model, system, user, timeoutMs: requestTimeoutMs }): Promise<ChatOutcome> {
      try {
        const response = await client.beta.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          // Short phrasing work: thinking stays on (it cannot be disabled on this model) at the lowest depth.
          output_config: { effort: 'low' },
          // If a safety classifier declines, the API reruns the request on its default fallback model in the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system,
          messages: [{ role: 'user', content: user }],
        }, { timeout: requestTimeoutMs ?? timeoutMs });
        // A refusal or a reply cut at max_tokens is not a usable answer.
        if (response.stop_reason !== 'end_turn') return { kind: 'error' };
        const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
        if (!text.trim()) return { kind: 'error' };
        return { kind: 'ok', text };
      } catch {
        return { kind: 'error' }; // API error, network error, timeout, or a malformed body
      }
    },
  };
}

/** One attempt: ask the model, validate its reply, and fall back to the deterministic brief on any failure. */
export async function writeBrief(input: WriterInput, chat: ModelChat): Promise<Brief> {
  const { system, user } = buildWriterPrompt(input);
  const outcome = await chat.chat({ model: BRIEF_MODEL, system, user });
  if (outcome.kind !== 'ok') return fallbackBrief(input);
  const draft = parseWriterOutput(outcome.text, input);
  return draft ? toBrief(draft, input) : fallbackBrief(input);
}
