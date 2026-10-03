// ADR-0044 Google reader tests. All fixtures are synthetic: no real token, subject, sender, title or event text.
import { describe, expect, it, vi } from 'vitest';
import { createGoogleReader } from './google-reader.ts';

const NOW = new Date('2026-06-15T05:00:00.000Z'); // 07:00 Europe/Copenhagen (CEST)
const TOKEN = 'SENTINEL-ACCESS-TOKEN';
const GOOD_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata https://www.googleapis.com/auth/calendar.readonly';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeReader(fetchImpl: typeof fetch, now: () => Date = () => NOW): ReturnType<typeof createGoogleReader> {
  return createGoogleReader({
    clientId: 'SENTINEL-CLIENT-ID',
    clientSecret: 'SENTINEL-CLIENT-SECRET',
    refreshToken: 'SENTINEL-REFRESH-TOKEN',
    fetch: fetchImpl,
    now,
  });
}

describe('createGoogleReader', () => {
  it('refreshes once per run and shares the in-memory token across calendar and mail', async () => {
    const calls: string[] = [];
    let tokenCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(`${url.hostname}${url.pathname}`);
      if (url.hostname === 'oauth2.googleapis.com') {
        tokenCalls++;
        return json({ access_token: TOKEN, scope: GOOD_SCOPE });
      }
      if (url.hostname === 'www.googleapis.com') {
        return json({ items: [{ summary: 'Stand-up', start: { dateTime: '2026-06-15T07:00:00+02:00' }, end: { dateTime: '2026-06-15T07:30:00+02:00' } }] });
      }
      if (url.pathname.endsWith('/labels')) return json({ labels: [] });
      return json({});
    }) as typeof fetch;

    const reader = makeReader(fetchImpl);
    const [calendar, mail] = await Promise.all([reader.readCalendar(), reader.readMail()]);
    expect(tokenCalls).toBe(1);
    expect(Array.isArray(calendar)).toBe(true);
    expect(Array.isArray(mail)).toBe(true);
  });

  it('queries the Copenhagen local day with DST-safe bounds and maps timed and all-day events', async () => {
    let calendarUrl: URL | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: TOKEN, scope: GOOD_SCOPE });
      if (url.hostname === 'www.googleapis.com') {
        calendarUrl = url;
        return json({
          items: [
            { summary: 'Timed', start: { dateTime: '2026-06-15T07:00:00+02:00' }, end: { dateTime: '2026-06-15T07:30:00+02:00' } },
            { summary: 'All day', start: { date: '2026-06-15' }, end: { date: '2026-06-16' } },
          ],
        });
      }
      return json({});
    }) as typeof fetch;

    const result = await makeReader(fetchImpl).readCalendar();
    expect(result).toEqual([
      { title: 'Timed', start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T05:30:00.000Z', allDay: false },
      { title: 'All day', start: '2026-06-15T00:00:00.000Z', end: '2026-06-16T00:00:00.000Z', allDay: true },
    ]);
    expect(calendarUrl?.searchParams.get('singleEvents')).toBe('true');
    expect(calendarUrl?.searchParams.get('timeMin')).toBe('2026-06-14T22:00:00.000Z');
    expect(calendarUrl?.searchParams.get('timeMax')).toBe('2026-06-15T22:00:00.000Z');
    expect(calendarUrl?.searchParams.get('fields')).toBe('items(summary,start,end)');
  });

  it('refuses a wrong OAuth scope with google-scope-mismatch and a 400 invalid_grant with google-reauth-needed', async () => {
    const mismatch = vi.fn(async () => json({ access_token: TOKEN, scope: 'calendar.readonly' })) as typeof fetch;
    await expect(makeReader(mismatch).readCalendar()).resolves.toEqual({
      code: 'google-scope-mismatch',
      message: 'reader unavailable',
      retryable: false,
    });

    const reauth = vi.fn(async () => json({ error: 'invalid_grant' }, 400)) as typeof fetch;
    const result = await makeReader(reauth).readMail();
    expect(result).toEqual({ code: 'google-reauth-needed', message: 'reader unavailable', retryable: false });
    expect(reauth).toHaveBeenCalledTimes(1);
  });

  it('reads metadata only: no q parameter and no full/raw body fetch, and maps sender/subject', async () => {
    const messageUrls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: TOKEN, scope: GOOD_SCOPE });
      if (url.pathname.endsWith('/labels')) {
        return json({ labels: [{ id: 'l1', name: 'Jev/Deadline' }, { id: 'l2', name: 'Jev/Payment' }, { id: 'l3', name: 'Jev/Needs reply' }] });
      }
      if (url.pathname === '/gmail/v1/users/me/messages') {
        const label = url.searchParams.getAll('labelIds').find((value) => value !== 'INBOX');
        const id = label === 'l1' ? 'm1' : label === 'l2' ? 'm2' : 'm3';
        return json({ messages: [{ id }] });
      }
      if (url.pathname.startsWith('/gmail/v1/users/me/messages/')) {
        messageUrls.push(url);
        const id = url.pathname.split('/').at(-1);
        const payload = id === 'm1'
          ? [{ name: 'From', value: 'Alice <alice@example.com>' }, { name: 'Subject', value: 'Contract' }, { name: 'Date', value: 'Mon, 15 Jun 2026 06:00:00 +0200' }]
          : id === 'm2'
            ? [{ name: 'From', value: 'Bob <bob@example.com>' }, { name: 'Subject', value: 'Invoice' }]
            : [{ name: 'From', value: 'Cleo <cleo@example.com>' }, { name: 'Subject', value: 'Question' }];
        return json({ payload: { headers: payload } });
      }
      return json({});
    }) as typeof fetch;

    const result = await makeReader(fetchImpl).readMail();
    expect(result).toEqual([
      { label: 'deadline', subject: 'Contract', sender: 'Alice' },
      { label: 'payment', subject: 'Invoice', sender: 'Bob' },
      { label: 'needs-reply', subject: 'Question', sender: 'Cleo' },
    ]);
    expect(messageUrls).toHaveLength(3);
    for (const url of messageUrls) {
      expect(url.searchParams.get('q')).toBeNull();
      expect(url.searchParams.get('format')).toBe('metadata');
      expect(url.searchParams.get('format')).not.toBe('full');
      expect(url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date', 'List-Unsubscribe']);
    }
  });

  it('drops automated senders (List-Unsubscribe, GitHub, CodeRabbit, no-reply) and caps at 10 items', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `m${i + 1}`);
    let messageGets = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: TOKEN, scope: GOOD_SCOPE });
      if (url.pathname.endsWith('/labels')) return json({ labels: [{ id: 'l1', name: 'Jev/Deadline' }] });
      if (url.pathname === '/gmail/v1/users/me/messages') return json({ messages: ids.map((id) => ({ id })) });
      if (url.pathname.startsWith('/gmail/v1/users/me/messages/')) {
        messageGets++;
        const id = url.pathname.split('/').at(-1);
        if (id === 'm1') return json({ payload: { headers: [{ name: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' }] } });
        if (id === 'm2') return json({ payload: { headers: [{ name: 'From', value: 'GitHub <notifications@github.com>' }] } });
        if (id === 'm3') return json({ payload: { headers: [{ name: 'From', value: 'CodeRabbit <coderabbit@example.com>' }] } });
        if (id === 'm4') return json({ payload: { headers: [{ name: 'From', value: 'Newsletter <no-reply@news.example>' }] } });
        return json({ payload: { headers: [{ name: 'From', value: `Person ${id} <person@example.com>` }, { name: 'Subject', value: `Subject ${id}` }] } });
      }
      return json({});
    }) as typeof fetch;

    const result = await makeReader(fetchImpl).readMail();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(10);
    expect(result).not.toContainEqual(expect.objectContaining({ sender: expect.stringMatching(/github|coderabbit|no-reply/i) }));
    expect(messageGets).toBeGreaterThanOrEqual(14);
  });

  it('returns a typed upstream-unavailable instead of throwing on network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); }) as typeof fetch;
    await expect(makeReader(fetchImpl).readCalendar()).resolves.toEqual({ code: 'upstream-unavailable', message: 'reader unavailable', retryable: true });
    await expect(makeReader(fetchImpl).readMail()).resolves.toEqual({ code: 'upstream-unavailable', message: 'reader unavailable', retryable: true });
  });
});
