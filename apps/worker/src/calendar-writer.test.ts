// ADR-0048/0052 Google calendar writer tests. All fixtures are synthetic: no real token, title, notes or event id.
import { CalendarEventCreateRequest } from '@vault-companion/domain';
import { describe, expect, it, vi } from 'vitest';
import { colorForType, createCalendarWriter, suggestType } from './calendar-writer.ts';

const NOW = new Date('2026-10-04T08:00:00.000Z');
const TOKEN = 'SENTINEL-ACCESS-TOKEN';
const GOOD_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const OP = '11111111-1111-4111-8111-111111111111';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeWriter(fetchImpl: typeof fetch, over: Record<string, unknown> = {}): ReturnType<typeof createCalendarWriter> {
  return createCalendarWriter({
    clientId: 'SENTINEL-CLIENT-ID',
    clientSecret: 'SENTINEL-CLIENT-SECRET',
    refreshToken: 'SENTINEL-REFRESH-TOKEN',
    fetch: fetchImpl,
    now: () => NOW,
    ...over,
  });
}

const timedRequest = (over: Record<string, unknown> = {}) => CalendarEventCreateRequest.parse({
  operationId: OP,
  itemKey: 'todo:1',
  title: 'Synthetic Stand-up',
  start: '2026-10-05T08:00:00+02:00',
  end: '2026-10-05T08:30:00+02:00',
  type: 'important',
  notes: 'Synthetic notes',
  ...over,
});

function tokenAnd(handler: (url: URL, init: RequestInit | undefined) => Promise<Response> | Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: TOKEN, scope: GOOD_SCOPE });
    return handler(url, init);
  }) as typeof fetch;
}

describe('insert', () => {
  it('refreshes once, dedupes by vcOperationId, and posts a timed event with colour and description', async () => {
    let tokenCalls = 0;
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'oauth2.googleapis.com') {
        tokenCalls++;
        return json({ access_token: TOKEN, scope: GOOD_SCOPE });
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posted.push({ url: url.href, body });
        return json({ id: 'event-1' });
      }
      expect(url.searchParams.get('privateExtendedProperty')).toBe(`vcOperationId=${OP}`);
      return json({ items: [] });
    }) as typeof fetch;

    const result = await makeWriter(fetchImpl).insert(timedRequest());
    expect(result).toEqual({ eventId: 'event-1' });
    expect(tokenCalls).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(CALENDAR);
    expect(posted[0]!.body).toMatchObject({
      summary: 'Synthetic Stand-up',
      description: 'From Vault Companion\nSynthetic notes',
      colorId: '11',
      extendedProperties: { private: { vcOperationId: OP } },
      start: { dateTime: '2026-10-05T08:00:00+02:00', timeZone: 'Europe/Copenhagen' },
      end: { dateTime: '2026-10-05T08:30:00+02:00', timeZone: 'Europe/Copenhagen' },
    });
  });

  it('posts an all-day event as date + exclusive next day, without timeZone', async () => {
    const fetchImpl = tokenAnd((url, init) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          start: { date: '2026-10-05' },
          end: { date: '2026-10-06' },
        });
        return json({ id: 'event-all-day' });
      }
      return json({ items: [] });
    });
    const result = await makeWriter(fetchImpl).insert(CalendarEventCreateRequest.parse({
      operationId: OP,
      itemKey: 'todo:1',
      title: 'Synthetic All-day',
      date: '2026-10-05',
      type: 'none',
    }));
    expect(result).toEqual({ eventId: 'event-all-day' });
  });

  it('double POST with the same operationId performs one insert, not two', async () => {
    let inserts = 0;
    let lists = 0;
    const fetchImpl = tokenAnd((_url, init) => {
      if (init?.method === 'POST') {
        inserts++;
        return json({ id: 'event-1' });
      }
      lists++;
      return json(lists === 1 ? { items: [] } : { items: [{ id: 'event-1' }] });
    });
    const writer = makeWriter(fetchImpl);
    expect(await writer.insert(timedRequest())).toEqual({ eventId: 'event-1' });
    expect(await writer.insert(timedRequest())).toEqual({ eventId: 'event-1' });
    expect(inserts).toBe(1);
    expect(lists).toBe(2);
  });
});

describe('remove', () => {
  it('gets the event first and refuses to delete an unmarked event', async () => {
    let deletes = 0;
    const fetchImpl = tokenAnd((url, init) => {
      if (init?.method === 'DELETE') {
        deletes++;
        return new Response(null, { status: 204 });
      }
      expect(url.searchParams.get('fields')).toBe('extendedProperties(private)');
      return json({ id: 'event-1', summary: 'Synthetic event without marker' });
    });
    const result = await makeWriter(fetchImpl).remove('event-1');
    expect(result).toEqual({ code: 'invalid', message: 'calendar event is not Worker-created', retryable: false });
    expect(deletes).toBe(0);
  });

  it('deletes only a Worker-created event and treats 404/410 as already gone', async () => {
    const fetchImpl = tokenAnd((_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ extendedProperties: { private: { vcOperationId: OP } } });
    });
    await expect(makeWriter(fetchImpl).remove('event-1')).resolves.toEqual({ removed: true });

    const gone = tokenAnd(() => json({ error: 'not found' }, 404));
    await expect(makeWriter(gone).remove('event-gone')).resolves.toEqual({ removed: true });
  });
});

describe('credential and network failures', () => {
  it('refuses a scope other than exactly calendar.events', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: TOKEN, scope: 'calendar.readonly' })) as typeof fetch;
    await expect(makeWriter(fetchImpl).insert(timedRequest())).resolves.toMatchObject({ code: 'google-scope-mismatch', retryable: false });
  });

  it('maps invalid_grant to google-reauth-needed', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'invalid_grant' }, 400)) as typeof fetch;
    await expect(makeWriter(fetchImpl).insert(timedRequest())).resolves.toMatchObject({ code: 'google-reauth-needed', retryable: false });
  });

  it('refuses an unset secret with calendar-write-unavailable before any fetch', async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    await expect(makeWriter(fetchImpl, { clientSecret: '' }).insert(timedRequest())).resolves.toMatchObject({ code: 'calendar-write-unavailable', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns typed upstream-unavailable instead of throwing on network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); }) as typeof fetch;
    await expect(makeWriter(fetchImpl).insert(timedRequest())).resolves.toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });
});

describe('pure helpers', () => {
  it('maps every type to its ADR-0048 colorId', () => {
    expect(colorForType('important')).toBe('11');
    expect(colorForType('training')).toBe('10');
    expect(colorForType('learning-practice')).toBe('10');
    expect(colorForType('ai')).toBe('3');
    expect(colorForType('learning-event')).toBe('9');
    expect(colorForType('tangerine')).toBe('6');
    expect(colorForType('banana')).toBe('5');
    expect(colorForType('flamingo')).toBe('4');
    expect(colorForType('graphite')).toBe('8');
    expect(colorForType('none')).toBeNull();
  });

  it('guesses deterministic keywords and falls back to none', () => {
    expect(suggestType('Submit the urgent report')).toBe('important');
    expect(suggestType('Fine-tune the claude model')).toBe('ai');
    expect(suggestType('Gym training session')).toBe('training');
    expect(suggestType('Piano practice')).toBe('learning-practice');
    expect(suggestType('Join the webinar')).toBe('learning-event');
    expect(suggestType('Buy tangerines')).toBe('tangerine');
    expect(suggestType('Read the calendar brief')).toBe('none');
  });
});
