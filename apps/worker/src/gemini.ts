// Gemini `generateContent` client behind the domain's PaperExplainer port (ADR-0029). The model reads the paper by URL
// (URL-context tool); the Worker never downloads it. Only status classes leave this file: never the key, the prompt,
// the paper or the model's text in an error or a log.
// API shape followed: https://ai.google.dev/gemini-api/docs/url-context and .../structured-output (REST, v1beta).
import { EXPLANATION_RESPONSE_SCHEMA, type ModelOutcome, type PaperExplainer } from '@vault-companion/domain';

export interface GeminiOptions {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
  /** Per call (ADR-0029: 60 s). */
  readonly timeoutMs?: number;
}

export const GEMINI_TIMEOUT_MS = 60_000;
const URL_OK = 'URL_RETRIEVAL_STATUS_SUCCESS';

interface GeminiPart {
  readonly text?: unknown;
  readonly thought?: unknown;
}
interface GeminiUrlMetadata {
  readonly urlRetrievalStatus?: unknown;
  readonly url_retrieval_status?: unknown;
}
interface GeminiCandidate {
  readonly content?: { readonly parts?: readonly GeminiPart[] };
  readonly finishReason?: unknown;
  readonly urlContextMetadata?: { readonly urlMetadata?: readonly GeminiUrlMetadata[] };
  readonly url_context_metadata?: { readonly url_metadata?: readonly GeminiUrlMetadata[] };
}

export function createGeminiExplainer(opts: GeminiOptions): PaperExplainer {
  // Bound: Workers throw "Illegal invocation" when the global fetch is called as a method of another object.
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.apiBase ?? 'https://generativelanguage.googleapis.com';
  const timeoutMs = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;
  return {
    async explain({ model, prompt }): Promise<ModelOutcome> {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await f(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            tools: [{ url_context: {} }],
            generationConfig: { responseMimeType: 'application/json', responseJsonSchema: EXPLANATION_RESPONSE_SCHEMA, temperature: 0.2 },
          }),
          signal: abort.signal,
        });
        if (res.status === 503) return { kind: 'unavailable' };
        if (res.status === 429) return (await isQuotaExhausted(res)) ? { kind: 'quota' } : { kind: 'unavailable' };
        if (res.status !== 200) return { kind: 'error' };
        const body = (await res.json()) as { candidates?: readonly GeminiCandidate[] };
        const candidate = body.candidates?.[0];
        if (!candidate) return { kind: 'error' };
        const urls = candidate.urlContextMetadata?.urlMetadata ?? candidate.url_context_metadata?.url_metadata ?? [];
        // No successful retrieval ⇒ the model did not read the paper: never write an explanation from its guess.
        if (!urls.some((u) => (u.urlRetrievalStatus ?? u.url_retrieval_status) === URL_OK)) return { kind: 'url-unreadable' };
        if (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') return { kind: 'error' };
        const text = (candidate.content?.parts ?? [])
          .filter((p) => p.thought !== true && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('');
        return text.trim() ? { kind: 'ok', text } : { kind: 'error' };
      } catch {
        return { kind: 'error' }; // network error or the 60 s timeout
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A 429 that names a QuotaFailure is quota (next model at once); any other 429 is rate limiting (retried once). */
async function isQuotaExhausted(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { error?: { details?: readonly { '@type'?: unknown }[] } };
    return (body.error?.details ?? []).some((d) => typeof d['@type'] === 'string' && d['@type'].endsWith('google.rpc.QuotaFailure'));
  } catch {
    return false;
  }
}
