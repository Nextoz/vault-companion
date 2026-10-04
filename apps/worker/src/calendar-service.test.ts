// ADR-0048/0052 composition tests: synthetic fixtures only.
import {
  CALENDAR_LINKS_PATH,
  CalendarEventCreateRequest,
  CalendarEventRemoveRequest,
  createCalendarLinksService,
  serializeCalendarLinksFile,
} from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { describe, expect, it } from 'vitest';
import { createCalendarService } from './calendar-service.ts';
import type { CalendarWriter } from './calendar-writer.ts';

const LINK_OP = '00000000-0000-4000-8000-000000000011';
const REMOVE_OP = '00000000-0000-4000-8000-000000000012';
const CREATE_OP = '00000000-0000-4000-8000-000000000013';
const ITEM_KEY = 'todo:1';
const CREATED_AT = '2026-10-04T08:00:00.000Z';

function seededLinks() {
  return serializeCalendarLinksFile({
    schema: 1,
    links: { [ITEM_KEY]: { eventId: 'event-marked', operationId: LINK_OP, createdAt: CREATED_AT } },
  });
}

describe('createCalendarService remove policy', () => {
  it('keeps an unmarked Google event, removes the link, and lets a later create recover', async () => {
    const store = await InMemoryStore.create({ [CALENDAR_LINKS_PATH]: seededLinks() });
    const links = createCalendarLinksService({ store, now: () => new Date(CREATED_AT) });
    const writer: CalendarWriter = {
      insert: async () => ({ eventId: 'event-new' }),
      remove: async () => ({ code: 'invalid', message: 'calendar event is not Worker-created', retryable: false }),
    };
    const service = createCalendarService({ links, writer });

    const removeRequest = CalendarEventRemoveRequest.parse({ operationId: REMOVE_OP, itemKey: ITEM_KEY });
    const removed = await service.removeCalendarEvent(removeRequest, removeRequest);
    expect(removed).toEqual({ removed: true, eventKept: true });
    await expect(links.readCalendarLinks()).resolves.toEqual({ revision: store.headCommit, links: {} });

    const createRequest = CalendarEventCreateRequest.parse({
      operationId: CREATE_OP,
      itemKey: ITEM_KEY,
      title: 'Synthetic recovery event',
      date: '2026-10-05',
      type: 'none',
    });
    const created = await service.createCalendarEvent(createRequest, createRequest);
    expect(created).toMatchObject({ eventId: 'event-new', link: { operationId: CREATE_OP } });
    await expect(links.readCalendarLinks()).resolves.toEqual({ revision: store.headCommit, links: { [ITEM_KEY]: 'event-new' } });
  });
});
