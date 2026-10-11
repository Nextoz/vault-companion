// ADR-0063: one saved reflection leaves to Scaleway; titles and other entries never enter the prompt.
import { BookFollowUpResponse, canonicalBookTitle, type ApiError, type BookFollowUpRequest, type BooksResponse } from '@vault-companion/contracts';
import type { ScalewayChat } from './scaleway-chat.ts';

export const BOOK_FOLLOW_UP_MODEL = 'glm-5.2';
export const BOOK_FOLLOW_UP_SYSTEM = 'ask one short follow-up question, one line, in the language of the text';
export const BOOK_FOLLOW_UP_TIMEOUT_MS = 30_000;

export interface BookFollowUpRateLimit { allow(): boolean }
export interface BookFollowUpDeps {
  readonly readBooks: () => Promise<BooksResponse | ApiError>;
  /** Absent when SCALEWAY_API_KEY is unset. */
  readonly chat?: ScalewayChat | undefined;
  readonly rateLimit?: BookFollowUpRateLimit;
  readonly now?: () => number;
}

/** Best-effort per-isolate cap, reset by UTC day and deploy, as in createJevDailyRateLimit. */
export function createBookFollowUpDailyRateLimit(limit = 5, now: () => number = () => Date.now()): BookFollowUpRateLimit {
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);
  let day = dayKey();
  let used = 0;
  return { allow() {
    const current = dayKey();
    if (current !== day) { day = current; used = 0; }
    if (used >= limit) return false;
    used += 1;
    return true;
  } };
}

const error = (code: ApiError['code'], message: string, retryable = false): ApiError => ({ code, message, retryable });

export function createBookFollowUpService(deps: BookFollowUpDeps) {
  const rateLimit = deps.rateLimit ?? createBookFollowUpDailyRateLimit(5, deps.now);
  return {
    async followUp(request: BookFollowUpRequest): Promise<BookFollowUpResponse | ApiError> {
      if (!deps.chat) return error('follow-up-unavailable', 'Follow-up questions are not configured for this vault yet.');
      const title = canonicalBookTitle(request.title);
      if (title === null) return error('refused:book-title-invalid', 'Book title cannot be used for a note name');
      let books: BooksResponse | ApiError;
      try { books = await deps.readBooks(); } catch {
        return error('follow-up-unavailable', 'The saved reflection is not available right now.', true);
      }
      if ('code' in books && 'retryable' in books) return books;
      if (books.status !== 'ok') return error('follow-up-unavailable', 'The saved reflection cannot be read.');
      const reflection = books.books.find((book) => book.title === title)?.reflections
        .filter((entry) => entry.date === request.date)[request.ordinal - 1];
      if (!reflection) return error('reflection-not-found', 'That saved reflection was not found.');
      // Only a valid, chat-bound request consumes the daily quota.
      if (!rateLimit.allow()) return error('follow-up-rate-limited', 'You have used today’s five follow-up questions. Try again tomorrow.');

      try {
        const outcome = await deps.chat.chat({ model: BOOK_FOLLOW_UP_MODEL, system: BOOK_FOLLOW_UP_SYSTEM, user: reflection.text, responseFormat: 'text', timeoutMs: BOOK_FOLLOW_UP_TIMEOUT_MS });
        if (outcome.kind !== 'ok') return error('follow-up-unavailable', 'Follow-up questions are not available right now.', true);
        const parsed = BookFollowUpResponse.safeParse({ question: outcome.text.trim() });
        if (!parsed.success) return error('follow-up-bad-output', 'The AI did not return one short question.');
        return parsed.data;
      } catch {
        return error('follow-up-unavailable', 'Follow-up questions are not available right now.', true);
      }
    },
  };
}
