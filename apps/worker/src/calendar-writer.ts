// ADR-0048/0052 Google Calendar writer adapter. The access token is refreshed once per factory instance and kept in
// memory only. No token, title, notes, scope or event id is ever logged or put in an error message (typed codes only).
import type { ApiError } from '@vault-companion/contracts';
import type { CalendarEventCreateRequest, CalendarEventType } from '@vault-companion/domain';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const REQUIRED_SCOPE = 'calendar.events';
const CALENDAR_TIME_ZONE = 'Europe/Copenhagen';

export interface CalendarWriterDeps {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetch: typeof fetch;
  readonly now: () => Date | number;
}

export type CalendarEventWriteResult = { readonly eventId: string };
export type CalendarEventRemoveResult = { readonly removed: true };

export interface CalendarWriter {
  insert(input: CalendarEventCreateRequest): Promise<CalendarEventWriteResult | ApiError>;
  remove(eventId: string): Promise<CalendarEventRemoveResult | ApiError>;
}

const apiError = (code: ApiError['code'], message: string, retryable: boolean): ApiError => ({ code, message, retryable });

const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

function scopeMatches(scope: unknown): boolean {
  if (typeof scope !== 'string') return false;
  const granted = scope.trim().split(/\s+/).filter(Boolean)
    .map((value) => value.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''))
    .sort();
  return granted.length === 1 && granted[0] === REQUIRED_SCOPE;
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** ADR-0048 colour mapping; `none` intentionally has no Google colorId. */
export function colorForType(type: CalendarEventType): string | null {
  switch (type) {
    case 'important': return '11';
    case 'training':
    case 'learning-practice': return '10';
    case 'ai': return '3';
    case 'learning-event': return '9';
    case 'tangerine': return '6';
    case 'banana': return '5';
    case 'flamingo': return '4';
    case 'graphite': return '8';
    case 'none': return null;
  }
}

/** Deterministic keyword guess for CAL-b; no model call, always falls back to `none`. */
export function suggestType(text: string, project?: string): CalendarEventType {
  const hay = `${text} ${project ?? ''}`.toLowerCase();
  if (/\b(important|urgent|deadline|critical)\b/.test(hay)) return 'important';
  if (/\b(ai|llm|gpt|claude|machine learning|fine-?tun(e|ing))\b/.test(hay)) return 'ai';
  if (/\b(training|workout|gym|run|fitness)\b/.test(hay)) return 'training';
  if (/\b(practice|rehearsal|drill)\b/.test(hay)) return 'learning-practice';
  if (/\b(learning event|webinar|conference|meetup|workshop)\b/.test(hay)) return 'learning-event';
  if (hay.includes('tangerine')) return 'tangerine';
  if (hay.includes('banana')) return 'banana';
  if (hay.includes('flamingo')) return 'flamingo';
  if (hay.includes('graphite')) return 'graphite';
  return 'none';
}

function privateMarker(event: Record<string, unknown> | null): boolean {
  const extended = asRecord(event?.extendedProperties);
  const priv = asRecord(extended?.private);
  return typeof priv?.vcOperationId === 'string' && priv.vcOperationId.trim() !== '';
}

export function createCalendarWriter(deps: CalendarWriterDeps): CalendarWriter {
  let tokenPromise: Promise<string | ApiError> | null = null;

  const refresh = async (): Promise<string | ApiError> => {
    if (!deps.clientId || !deps.clientSecret || !deps.refreshToken) {
      return apiError('calendar-write-unavailable', 'calendar writer is not configured', false);
    }
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        refresh_token: deps.refreshToken,
      });
      const res = await deps.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const json = await res.json().catch(() => null);
      const root = asRecord(json);
      if (res.status === 400 && root?.error === 'invalid_grant') return apiError('google-reauth-needed', 'calendar writer needs reauthorisation', false);
      if (!res.ok) return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
      if (typeof root?.access_token !== 'string' || root.access_token === '') return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
      if (!scopeMatches(root.scope)) return apiError('google-scope-mismatch', 'calendar writer scope is not calendar.events', false);
      return root.access_token;
    } catch {
      return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
    }
  };

  const ensureToken = async (): Promise<string | ApiError> => {
    if (!tokenPromise) tokenPromise = refresh();
    const token = await tokenPromise;
    if (isApiError(token)) tokenPromise = null;
    return token;
  };

  const insert = async (input: CalendarEventCreateRequest): Promise<CalendarEventWriteResult | ApiError> => {
    const token = await ensureToken();
    if (isApiError(token)) return token;
    try {
      const listParams = new URLSearchParams({
        privateExtendedProperty: `vcOperationId=${input.operationId}`,
        fields: 'items(id)',
      });
      const listed = await deps.fetch(`${CALENDAR_URL}?${listParams.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!listed.ok) return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
      const listRoot = asRecord(await listed.json().catch(() => null));
      const items = listRoot && Array.isArray(listRoot.items) ? listRoot.items : [];
      for (const item of items) {
        const id = asRecord(item)?.id;
        if (typeof id === 'string' && id !== '') return { eventId: id };
      }

      const body: Record<string, unknown> = {
        summary: input.title,
        description: `From Vault Companion${input.notes === undefined ? '' : `\n${input.notes}`}`,
        extendedProperties: { private: { vcOperationId: input.operationId } },
      };
      const colorId = colorForType(input.type);
      if (colorId !== null) body.colorId = colorId;
      if (input.date !== undefined) {
        body.start = { date: input.date };
        body.end = { date: nextDate(input.date) };
      } else {
        body.start = { dateTime: input.start, timeZone: CALENDAR_TIME_ZONE };
        body.end = { dateTime: input.end, timeZone: CALENDAR_TIME_ZONE };
      }
      const created = await deps.fetch(CALENDAR_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!created.ok) return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
      const root = asRecord(await created.json().catch(() => null));
      const eventId = typeof root?.id === 'string' ? root.id : '';
      if (eventId === '') return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
      return { eventId };
    } catch {
      return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
    }
  };

  const remove = async (eventId: string): Promise<CalendarEventRemoveResult | ApiError> => {
    const token = await ensureToken();
    if (isApiError(token)) return token;
    try {
      const encoded = encodeURIComponent(eventId);
      const eventUrl = `${CALENDAR_URL}/${encoded}`;
      const params = new URLSearchParams({ fields: 'extendedProperties(private)' });
      const got = await deps.fetch(`${eventUrl}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (got.status === 404 || got.status === 410) return { removed: true };
      if (!got.ok) return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
      const event = asRecord(await got.json().catch(() => null));
      if (!privateMarker(event)) return apiError('invalid', 'calendar event is not Worker-created', false);
      const deleted = await deps.fetch(eventUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (deleted.status === 404 || deleted.status === 410) return { removed: true };
      if (!deleted.ok) return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
      return { removed: true };
    } catch {
      return apiError('upstream-unavailable', 'calendar writer is unavailable', true);
    }
  };

  return { insert, remove };
}
