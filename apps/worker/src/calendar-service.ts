// ADR-0048/0052 composition: Google event writes are idempotent on `operationId` and the vault links file is the
// durable link. A lost link write after a successful insert is retried by the same operation ID; Google list dedupe
// returns the existing event and the link write completes. No event text or event ids are logged here.
import type { ApiError } from '@vault-companion/contracts';
import {
  type CalendarEventCreateRequest,
  type CalendarEventCreateResponse,
  type CalendarEventRemoveRequest,
  type CalendarEventRemoveResponse,
  type CalendarLinksResponse,
  createCalendarLinksService,
} from '@vault-companion/domain';
import type { CalendarWriter } from './calendar-writer.ts';

const apiError = (code: ApiError['code'], message: string, retryable: boolean): ApiError => ({ code, message, retryable });

const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;

export interface CalendarServiceDeps {
  readonly links: ReturnType<typeof createCalendarLinksService>;
  readonly writer: CalendarWriter;
}

export interface CalendarService {
  readCalendarLinks(): Promise<CalendarLinksResponse | ApiError>;
  createCalendarEvent(request: CalendarEventCreateRequest, raw: unknown): Promise<CalendarEventCreateResponse | ApiError>;
  removeCalendarEvent(request: CalendarEventRemoveRequest, raw: unknown): Promise<CalendarEventRemoveResponse | ApiError>;
}

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  return {
    async readCalendarLinks() {
      return deps.links.readCalendarLinks();
    },

    async createCalendarEvent(request, raw) {
      const existing = await deps.links.findCalendarLink(request.itemKey);
      if (isApiError(existing)) return existing;
      if (existing) {
        if (existing.operationId === request.operationId) return { eventId: existing.eventId, link: existing };
        return apiError('conflict:stale', 'calendar link already exists for this item', true);
      }

      const created = await deps.writer.insert(request);
      if (isApiError(created)) return created;

      const written = await deps.links.putCalendarLink({
        operationId: request.operationId,
        itemKey: request.itemKey,
        eventId: created.eventId,
        raw,
      });
      if (isApiError(written)) return written;
      return { eventId: written.link.eventId, link: written.link };
    },

    async removeCalendarEvent(request, raw) {
      const existing = await deps.links.findCalendarLink(request.itemKey);
      if (isApiError(existing)) return existing;
      if (!existing) return { removed: true };

      const removed = await deps.writer.remove(existing.eventId);
      if (isApiError(removed)) {
        if (removed.code !== 'invalid') return removed;
        const unlinked = await deps.links.removeCalendarLink({
          operationId: request.operationId,
          itemKey: request.itemKey,
          raw,
        });
        if (isApiError(unlinked)) return unlinked;
        return { removed: true, eventKept: true };
      }

      const unlinked = await deps.links.removeCalendarLink({
        operationId: request.operationId,
        itemKey: request.itemKey,
        raw,
      });
      if (isApiError(unlinked)) return unlinked;
      return { removed: true };
    },
  };
}
