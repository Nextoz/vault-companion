// Ask Jev (ADR-0057): the only Worker code that calls TypeSafe. It reads the note through the existing notes read
// path (the client sends a note path, never note text), refuses excluded paths and over-long notes before any
// outbound call, and parses TypeSafe's typed answers strictly: an unrecognised answer is a typed error, never a guess.
import type { ApiError, AskJevQuestion, AskJevResponse, NoteReadResponse } from '@vault-companion/contracts';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.13.0';
export const MAX_ASK_JEV_NOTE_CHARS = 100_000;
export const DEFAULT_ASK_JEV_PER_DAY = 50;
export const ASK_JEV_TIMEOUT_MS = 25_000;

export interface JevRateLimit {
  allow(): boolean;
}

export interface JevServiceDeps {
  readonly readNote: (path: string) => Promise<NoteReadResponse | ApiError>;
  readonly fetch: typeof fetch;
  readonly apiKey?: string | undefined;
  readonly rateLimit?: JevRateLimit | undefined;
  readonly timeoutMs?: number | undefined;
}

const apiError = (code: ApiError['code'], message: string, retryable: boolean): ApiError => ({ code, message, retryable });

const isApiError = (value: NoteReadResponse | ApiError): value is ApiError => 'code' in value && 'retryable' in value;

/** A note anywhere directly under Health/ or Journal/ is out of scope, case-insensitively after normalisation. */
export function isJevAllowedPath(path: string): boolean {
  const normalised = path.normalize('NFC').replaceAll('\\', '/').toLowerCase();
  return !(normalised === 'health' || normalised.startsWith('health/')
    || normalised === 'journal' || normalised.startsWith('journal/'));
}

const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Best-effort per-isolate daily cap. Cloudflare's execution model makes this approximate across isolates (and it
 * resets with a deploy), but it still stops an in-app loop from spending money for the rest of the day. There is no
 * existing KV/Durable Object rate-limit pattern in this codebase to reuse.
 */
export function createJevDailyRateLimit(limit = DEFAULT_ASK_JEV_PER_DAY, now: () => number = () => Date.now()): JevRateLimit {
  let day = dayKey(now());
  let used = 0;
  return {
    allow(): boolean {
      const current = dayKey(now());
      if (current !== day) {
        day = current;
        used = 0;
      }
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
}

type JevWireQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice' | 'score'; instructions: string; criteria: Record<string, string> };

function wireQuestion(question: AskJevQuestion): JevWireQuestion {
  switch (question.kind) {
    case 'yes-no':
      return { type: 'noul', instructions: question.question };
    case 'choose':
      return {
        type: 'choice',
        instructions: question.question,
        criteria: {
          ...Object.fromEntries(question.options.map((option) => [option, option])),
          unresolved: 'Evidence is insufficient to decide',
        },
      };
    case 'rate':
      // `score` is built like `choice` in the owner's Python client; the live score shape is UNVERIFIED, so the
      // mapping is isolated here for an easy follow-up if TypeSafe answers differently.
      return {
        type: 'score',
        instructions: question.question,
        criteria: Object.fromEntries(question.levels.map((level) => [level, level])),
      };
  }
}

function wireBody(noteText: string, questions: readonly AskJevQuestion[]): string {
  return JSON.stringify({
    model: JEV_MODEL,
    state: {
      note: noteText,
      instructions_context: 'Answer each question using only the note text in state.note.',
    },
    questions: Object.fromEntries(questions.map((question, index) => [`q${index + 1}`, wireQuestion(question)])),
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function probabilityInUnit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return value;
}

function probabilitiesRecord(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    const parsed = probabilityInUnit(probability);
    if (parsed === undefined) return null;
    out[key] = parsed;
  }
  return out;
}

/** Strict parser for `raw.answers`. Returns `null` on any unknown type or missing field so the caller can refuse. */
export function parseJevAnswers(raw: unknown, questions: readonly AskJevQuestion[]): AskJevResponse['answers'] | null {
  if (!isRecord(raw) || !isRecord(raw.answers)) return null;
  const answers = raw.answers;
  const out: AskJevResponse['answers'] = [];
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]!;
    const answer = answers[`q${index + 1}`];
    if (!isRecord(answer)) return null;
    switch (question.kind) {
      case 'yes-no': {
        if (answer.type !== 'noul') return null;
        const probability = probabilityInUnit(answer.noul) ?? probabilityInUnit(answer.probability);
        if (probability === undefined) return null;
        out.push({ kind: 'yes-no', question: question.question, probability });
        break;
      }
      case 'choose': {
        if (answer.type !== 'choice' || typeof answer.choice !== 'string') return null;
        const probabilities = probabilitiesRecord(answer.probabilities);
        if (!probabilities || Object.keys(probabilities).length === 0) return null;
        out.push({ kind: 'choose', question: question.question, choice: answer.choice, probabilities });
        break;
      }
      case 'rate': {
        if (answer.type !== 'score') return null;
        const score = typeof answer.score === 'number' ? String(answer.score) : typeof answer.score === 'string' ? answer.score : '';
        const probabilities = probabilitiesRecord(answer.probabilities);
        if (!score || !probabilities || Object.keys(probabilities).length === 0) return null;
        out.push({ kind: 'rate', question: question.question, score, probabilities });
        break;
      }
    }
  }
  return out;
}

function refusalError(note: Extract<NoteReadResponse, { status: 'refused' }>): ApiError {
  if (note.code === 'not-found') return apiError('not-found', note.message, false);
  if (note.code === 'too-large') return apiError('note-too-long', note.message, false);
  return apiError('jev-excluded-path', note.message, false);
}

export function createJevService(deps: JevServiceDeps) {
  const rateLimit = deps.rateLimit ?? createJevDailyRateLimit();
  return {
    async askJev(path: string, questions: readonly AskJevQuestion[]): Promise<AskJevResponse | ApiError> {
      if (!isJevAllowedPath(path)) {
        return apiError('jev-excluded-path', 'Jev cannot read Health or Journal notes.', false);
      }
      const note = await deps.readNote(path);
      if (isApiError(note)) return note;
      if (note.status === 'refused') return refusalError(note);
      if (note.markdown.length > MAX_ASK_JEV_NOTE_CHARS) {
        return apiError('note-too-long', 'This note is too long to send to Jev yet.', false);
      }
      if (!deps.apiKey) return apiError('jev-unavailable', 'Jev is not configured for this vault yet.', false);
      if (!rateLimit.allow()) {
        return apiError('jev-rate-limited', 'Jev has answered enough questions for today. Try again tomorrow.', false);
      }

      const timeoutMs = deps.timeoutMs ?? ASK_JEV_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await deps.fetch(JEV_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${deps.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: wireBody(note.markdown, questions),
          signal: controller.signal,
        });
        if (!response.ok) {
          return apiError('jev-unavailable', 'Jev is not available right now.', response.status >= 500);
        }
        const raw: unknown = await response.json().catch(() => undefined);
        const answers = parseJevAnswers(raw, questions);
        if (!answers) return apiError('jev-bad-answer', 'Jev returned an answer this app cannot read.', false);
        return { answers };
      } catch {
        if (controller.signal.aborted) return apiError('jev-unavailable', 'Jev did not answer in time.', true);
        return apiError('jev-unavailable', 'Jev is not reachable right now.', true);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
