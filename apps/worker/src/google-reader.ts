// ADR-0044 read-only Google adapter for the Morning Brief. The access token is refreshed once per cron run and kept
// in memory only. Calendar returns BriefEvents; mail returns metadata-only GoogleMailItems for the gatherer to map.
// No token, scope, subject, sender, title or event text is ever logged or put in an error message (typed codes only).
import type { ApiError } from '@vault-companion/contracts';
import { localWallToInstant, userDate, type BriefEvent } from '@vault-companion/domain';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MORNING_BRIEF_TIME_ZONE = 'Europe/Copenhagen';

const LABELS: readonly { readonly label: JevLabel; readonly name: string }[] = [
  { label: 'deadline', name: 'Jev/Deadline' },
  { label: 'payment', name: 'Jev/Payment' },
  { label: 'needs-reply', name: 'Jev/Needs reply' },
];

const REQUIRED_SCOPES = ['calendar.readonly', 'gmail.metadata'] as const;
const MAX_MAIL_ITEMS = 10;

export type JevLabel = 'deadline' | 'payment' | 'needs-reply';

/** Metadata-only mail item; the gatherer turns it into the single BriefTodo text that may reach the writer model. */
export interface GoogleMailItem {
  readonly label: JevLabel;
  readonly subject: string;
  readonly sender: string;
}

export interface GoogleReaderDeps {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetch: typeof fetch;
  readonly now: () => Date | number;
}

export interface GoogleReader {
  readCalendar(): Promise<readonly BriefEvent[] | ApiError>;
  readMail(): Promise<readonly GoogleMailItem[] | ApiError>;
}

const apiError = (code: ApiError['code'], retryable: boolean): ApiError => ({
  code,
  message: 'reader unavailable',
  retryable,
});

const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

function scopeMatches(scope: unknown): boolean {
  if (typeof scope !== 'string') return false;
  const granted = scope.trim().split(/\s+/).filter(Boolean)
    .map((value) => value.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''))
    .sort();
  return granted.length === 2 && granted[0] === REQUIRED_SCOPES[0] && granted[1] === REQUIRED_SCOPES[1];
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function calendarInstant(raw: Record<string, unknown> | null, allDay: boolean): string | null {
  if (!raw) return null;
  const value = allDay ? raw.date : raw.dateTime;
  if (typeof value !== 'string') return null;
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    return new Date(`${value}T00:00:00Z`).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseCalendar(body: unknown): BriefEvent[] {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.items)) return [];
  const events: BriefEvent[] = [];
  for (const item of root.items) {
    const raw = asRecord(item);
    if (!raw) continue;
    const startRaw = asRecord(raw.start);
    const endRaw = asRecord(raw.end);
    const allDay = typeof startRaw?.date === 'string';
    const start = calendarInstant(startRaw, allDay);
    const end = calendarInstant(endRaw, allDay);
    if (!start || !end) continue;
    events.push({ title: typeof raw.summary === 'string' ? raw.summary : '', start, end, allDay });
  }
  return events;
}

function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  const wanted = name.toLowerCase();
  for (const header of headers) {
    const raw = asRecord(header);
    if (raw && typeof raw.name === 'string' && raw.name.toLowerCase() === wanted && typeof raw.value === 'string') {
      return raw.value;
    }
  }
  return '';
}

function senderName(from: string): string {
  const named = /^([^<]*)\s*<[^>]+>/.exec(from)?.[1]?.trim();
  if (named) return named;
  const email = /<([^>]+)>/.exec(from)?.[1]?.trim();
  return email || from.trim();
}

function isAutomated(from: string, listUnsubscribe: string): boolean {
  if (listUnsubscribe.trim() !== '') return true;
  const sender = from.toLowerCase();
  return sender.includes('github') || sender.includes('coderabbit') || sender.includes('no-reply') || sender.includes('noreply');
}

function parseMailItem(body: unknown, label: JevLabel): GoogleMailItem | null {
  const root = asRecord(body);
  const headers = root ? asRecord(root.payload)?.headers : null;
  const from = headerValue(headers, 'From');
  const subject = headerValue(headers, 'Subject');
  const unsubscribe = headerValue(headers, 'List-Unsubscribe');
  if (isAutomated(from, unsubscribe)) return null;
  return { label, subject, sender: senderName(from) };
}

export function createGoogleReader(deps: GoogleReaderDeps): GoogleReader {
  let tokenPromise: Promise<string | ApiError> | null = null;

  const refresh = async (): Promise<string | ApiError> => {
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
      if (res.status === 400 && root?.error === 'invalid_grant') return apiError('google-reauth-needed', false);
      if (!res.ok) return apiError('upstream-unavailable', true);
      if (typeof root?.access_token !== 'string' || root.access_token === '') return apiError('upstream-unavailable', true);
      if (!scopeMatches(root.scope)) return apiError('google-scope-mismatch', false);
      return root.access_token;
    } catch {
      return apiError('upstream-unavailable', true);
    }
  };

  const ensureToken = (): Promise<string | ApiError> => {
    if (!tokenPromise) tokenPromise = refresh();
    return tokenPromise;
  };

  const readCalendar = async (): Promise<readonly BriefEvent[] | ApiError> => {
    const token = await ensureToken();
    if (isApiError(token)) return token;
    try {
      const now = deps.now();
      const day = userDate(typeof now === 'number' ? new Date(now) : now, MORNING_BRIEF_TIME_ZONE);
      const timeMin = new Date(localWallToInstant(day, 0, 0, MORNING_BRIEF_TIME_ZONE)).toISOString();
      const timeMax = new Date(localWallToInstant(nextDate(day), 0, 0, MORNING_BRIEF_TIME_ZONE)).toISOString();
      const params = new URLSearchParams({
        singleEvents: 'true',
        timeMin,
        timeMax,
        fields: 'items(summary,start,end)',
      });
      const res = await deps.fetch(`${CALENDAR_URL}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return apiError('upstream-unavailable', true);
      return parseCalendar(await res.json().catch(() => null));
    } catch {
      return apiError('upstream-unavailable', true);
    }
  };

  const listLabelIds = async (token: string): Promise<Record<string, string> | ApiError> => {
    try {
      const params = new URLSearchParams({ fields: 'labels(id,name)' });
      const res = await deps.fetch(`${GMAIL_BASE}/labels?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return apiError('upstream-unavailable', true);
      const root = asRecord(await res.json().catch(() => null));
      const byName: Record<string, string> = {};
      if (root && Array.isArray(root.labels)) {
        for (const label of root.labels) {
          const raw = asRecord(label);
          if (raw && typeof raw.id === 'string' && typeof raw.name === 'string') byName[raw.name] = raw.id;
        }
      }
      return byName;
    } catch {
      return apiError('upstream-unavailable', true);
    }
  };

  const listMessageIds = async (token: string, labelId: string): Promise<readonly string[] | ApiError> => {
    try {
      const params = new URLSearchParams({ maxResults: String(MAX_MAIL_ITEMS), fields: 'messages(id)' });
      params.append('labelIds', 'INBOX');
      params.append('labelIds', labelId);
      const res = await deps.fetch(`${GMAIL_BASE}/messages?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return apiError('upstream-unavailable', true);
      const root = asRecord(await res.json().catch(() => null));
      if (!root || !Array.isArray(root.messages)) return [];
      return root.messages
        .map((message) => asRecord(message)?.id)
        .filter((id): id is string => typeof id === 'string');
    } catch {
      return apiError('upstream-unavailable', true);
    }
  };

  const readMessage = async (token: string, messageId: string, label: JevLabel): Promise<GoogleMailItem | null | ApiError> => {
    try {
      const params = new URLSearchParams({ format: 'metadata', fields: 'payload/headers' });
      params.append('metadataHeaders', 'From');
      params.append('metadataHeaders', 'Subject');
      params.append('metadataHeaders', 'Date');
      params.append('metadataHeaders', 'List-Unsubscribe');
      const res = await deps.fetch(`${GMAIL_BASE}/messages/${messageId}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return apiError('upstream-unavailable', true);
      return parseMailItem(await res.json().catch(() => null), label);
    } catch {
      return apiError('upstream-unavailable', true);
    }
  };

  const readMail = async (): Promise<readonly GoogleMailItem[] | ApiError> => {
    const token = await ensureToken();
    if (isApiError(token)) return token;
    const labelIds = await listLabelIds(token);
    if (isApiError(labelIds)) return labelIds;

    const seen = new Set<string>();
    const items: GoogleMailItem[] = [];
    for (const { label, name } of LABELS) {
      const labelId = labelIds[name];
      if (!labelId) continue;
      const ids = await listMessageIds(token, labelId);
      if (isApiError(ids)) return ids;
      for (const messageId of ids) {
        if (seen.has(messageId) || items.length >= MAX_MAIL_ITEMS) continue;
        seen.add(messageId);
        const item = await readMessage(token, messageId, label);
        if (isApiError(item)) return item;
        if (item) items.push(item);
      }
      if (items.length >= MAX_MAIL_ITEMS) break;
    }
    return items;
  };

  return { readCalendar, readMail };
}
