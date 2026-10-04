// ADR-0052: the one derived JSON file the calendar-write Worker may create or update. Pure domain code; no HTTP,
// no Worker imports, and no task/note text in commit messages or errors.
import type { ApiError } from '@vault-companion/contracts';
import { z } from 'zod';
import { CALENDAR_LINKS_PATH, canWrite, parseVaultPath } from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, TRAILER_OP, TRAILER_PAYLOAD, type VaultPath, type VaultStore } from './store.ts';

const parsedPath = parseVaultPath(CALENDAR_LINKS_PATH);
if (!parsedPath) throw new Error('calendar links path is not a writable vault path');
const PATH: VaultPath = parsedPath;
const DIR = CALENDAR_LINKS_PATH.slice(0, CALENDAR_LINKS_PATH.lastIndexOf('/'));

const commitSha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a 40-hex commit SHA');
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => {
    const midnight = `${s}T00:00:00.000Z`;
    return Number.isFinite(Date.parse(midnight)) && new Date(midnight).toISOString().slice(0, 10) === s;
  }, 'must be a valid calendar date');
const calendarDateTime = z.iso.datetime({ offset: true });
const singleLine = (max: number) => z.string().trim().min(1).max(max)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), 'must not contain control or separator characters');

export const CalendarItemKey = z.string().min(1).max(512)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s), 'must not contain control or separator characters');
export type CalendarItemKey = z.infer<typeof CalendarItemKey>;

/** ADR-0048 colour buckets; the Google colorId mapping lives in the Worker calendar writer. */
export const CalendarEventType = z.enum([
  'important', 'training', 'learning-practice', 'ai', 'learning-event',
  'tangerine', 'banana', 'flamingo', 'graphite', 'none',
]);
export type CalendarEventType = z.infer<typeof CalendarEventType>;

export const CalendarLink = z.strictObject({
  eventId: z.string().min(1).max(1024),
  operationId: z.uuid(),
  createdAt: calendarDateTime,
});
export type CalendarLink = z.infer<typeof CalendarLink>;

export const CalendarLinksFile = z.object({
  schema: z.literal(1),
  links: z.record(z.string(), CalendarLink),
});
export type CalendarLinksFile = z.infer<typeof CalendarLinksFile>;

export const CalendarEventCreateRequest = z.strictObject({
  operationId: z.uuid(),
  itemKey: CalendarItemKey,
  title: singleLine(500),
  date: calendarDate.optional(),
  start: calendarDateTime.optional(),
  end: calendarDateTime.optional(),
  type: CalendarEventType,
  notes: z.string().max(2000).optional(),
})
  .refine((r) => (r.date === undefined) !== (r.start === undefined && r.end === undefined), 'exactly one of date or start/end')
  .refine((r) => r.date !== undefined || (r.start !== undefined && r.end !== undefined), 'timed events need both start and end')
  .refine((r) => r.start === undefined || r.end === undefined || Date.parse(r.end) > Date.parse(r.start), 'end must be after start');
export type CalendarEventCreateRequest = z.infer<typeof CalendarEventCreateRequest>;

export const CalendarEventRemoveRequest = z.strictObject({
  operationId: z.uuid(),
  itemKey: CalendarItemKey,
});
export type CalendarEventRemoveRequest = z.infer<typeof CalendarEventRemoveRequest>;

export const CalendarLinksResponse = z.strictObject({
  revision: commitSha,
  links: z.record(z.string(), z.string()),
});
export type CalendarLinksResponse = z.infer<typeof CalendarLinksResponse>;

export const CalendarEventCreateResponse = z.strictObject({
  eventId: z.string().min(1),
  link: CalendarLink,
});
export type CalendarEventCreateResponse = z.infer<typeof CalendarEventCreateResponse>;

export const CalendarEventRemoveResponse = z.strictObject({ removed: z.literal(true) });
export type CalendarEventRemoveResponse = z.infer<typeof CalendarEventRemoveResponse>;

/** Validate raw bytes/text/JSON into a links file; never throws. */
export function parseCalendarLinksFile(raw: unknown): CalendarLinksFile | null {
  try {
    let value = raw;
    if (value instanceof Uint8Array) {
      value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    }
    if (typeof value === 'string') value = JSON.parse(value);
    const parsed = CalendarLinksFile.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Deterministic JSON bytes: stable existing key order, two-space indentation, one trailing newline. */
export function serializeCalendarLinksFile(file: CalendarLinksFile): Uint8Array {
  const json = { schema: 1, links: file.links };
  return new TextEncoder().encode(`${JSON.stringify(json, null, 2)}\n`);
}

export interface CalendarLinkWriteInput {
  readonly operationId: string;
  readonly itemKey: string;
  readonly eventId: string;
  readonly raw: unknown;
}

export interface CalendarLinkRemoveInput {
  readonly operationId: string;
  readonly itemKey: string;
  readonly raw: unknown;
}

export interface CalendarLinkWriteOutcome {
  readonly status: 'applied' | 'already-applied';
  readonly commitSha: string;
  readonly blobSha: string;
  readonly link: CalendarLink;
}

export interface CalendarLinkRemoveOutcome {
  readonly status: 'removed' | 'already-removed';
  readonly revision: string;
}

const apiError = (code: ApiError['code'], message: string, retryable = false): ApiError => ({ code, message, retryable });

const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;

type LinkFileRead = { readonly kind: 'file'; readonly file: CalendarLinksFile; readonly blobSha: string; readonly commitSha: string }
  | { readonly kind: 'absent' }
  | ApiError;

function storeFailure(e: unknown): ApiError | null {
  if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
    return apiError('upstream-unavailable', 'GitHub is not reachable right now', true);
  }
  return null;
}

async function readLinksFile(store: VaultStore, revision: string): Promise<LinkFileRead> {
  try {
    const file = await store.readFile(PATH, revision);
    if (!file) return { kind: 'absent' };
    const parsed = parseCalendarLinksFile(file.bytes);
    if (!parsed) return apiError('invalid', 'the calendar links file is not valid JSON');
    return { kind: 'file', file: parsed, blobSha: file.blobSha, commitSha: file.commitSha };
  } catch (e) {
    const failed = storeFailure(e);
    if (failed) return failed;
    throw e;
  }
}

function createdAt(now: Date | number): string {
  return new Date(now).toISOString();
}

export interface CalendarLinksDeps {
  readonly store: VaultStore;
  readonly now: () => Date | number;
}

export function createCalendarLinksService(deps: CalendarLinksDeps) {
  return {
    async readCalendarLinks(): Promise<CalendarLinksResponse | ApiError> {
      try {
        const { commitSha: revision } = await deps.store.head();
        const listed = (await deps.store.listFiles(DIR, revision)).find((f) => f.path === CALENDAR_LINKS_PATH);
        if (!listed) return apiError('not-found', 'the calendar links file does not exist');
        const file = await deps.store.readFile(PATH, revision);
        if (!file || file.blobSha !== listed.blobSha) return apiError('invalid', 'the calendar links file could not be read safely');
        const parsed = parseCalendarLinksFile(file.bytes);
        if (!parsed) return apiError('invalid', 'the calendar links file is not valid JSON');
        return {
          revision,
          links: Object.fromEntries(Object.entries(parsed.links).map(([key, link]) => [key, link.eventId])),
        };
      } catch (e) {
        const failed = storeFailure(e);
        if (failed) return failed;
        throw e;
      }
    },

    async findCalendarLink(itemKey: string): Promise<CalendarLink | null | ApiError> {
      try {
        const { commitSha: revision } = await deps.store.head();
        const existing = await readLinksFile(deps.store, revision);
        if (isApiError(existing)) return existing;
        return existing.kind === 'file' ? existing.file.links[itemKey] ?? null : null;
      } catch (e) {
        const failed = storeFailure(e);
        if (failed) return failed;
        throw e;
      }
    },

    async putCalendarLink(input: CalendarLinkWriteInput): Promise<CalendarLinkWriteOutcome | ApiError> {
      let unknown = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { commitSha: base } = await deps.store.head();
        const existing = await readLinksFile(deps.store, base);
        if (isApiError(existing)) return existing;
        const kind = existing.kind === 'file' ? 'update' : 'create';
        if (!canWrite(PATH, kind)) return apiError('refused:path', 'calendar links path is not allowed');

        if (existing.kind === 'file') {
          const prior = existing.file.links[input.itemKey];
          if (prior) {
            if (prior.operationId === input.operationId) {
              return { status: 'already-applied', commitSha: base, blobSha: existing.blobSha, link: prior };
            }
            return apiError('conflict:stale', 'calendar link already exists for this item', true);
          }
        }

        const link: CalendarLink = {
          eventId: input.eventId,
          operationId: input.operationId,
          createdAt: createdAt(deps.now()),
        };
        const links = existing.kind === 'file'
          ? { ...existing.file.links, [input.itemKey]: link }
          : { [input.itemKey]: link };
        const bytes = serializeCalendarLinksFile({ schema: 1, links });
        try {
          const res = await deps.store.writeFile({
            path: PATH,
            baseCommit: base,
            expect: existing.kind === 'file' ? 'regular-file' : 'absent',
            bytes,
            message: 'Vault Companion: update calendar links',
            trailers: { [TRAILER_OP]: input.operationId, [TRAILER_PAYLOAD]: await payloadHash(input.raw) },
          });
          if (res.ok) return { status: 'applied', commitSha: res.commitSha, blobSha: res.blobSha, link };
          if (res.reason === 'precondition-failed') return apiError('refused:structure', 'the calendar links file is not what this change expects; nothing was written');
        } catch (e) {
          if (e instanceof StoreUnknownOutcome) {
            unknown = true;
            continue;
          }
          const failed = storeFailure(e);
          if (failed) return failed;
          throw e;
        }
      }
      return unknown
        ? apiError('upstream-unavailable', 'GitHub did not confirm the calendar links write; it will be retried safely', true)
        : apiError('conflict:stale', 'the vault kept changing; try again', true);
    },

    async removeCalendarLink(input: CalendarLinkRemoveInput): Promise<CalendarLinkRemoveOutcome | ApiError> {
      let unknown = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { commitSha: base } = await deps.store.head();
        const existing = await readLinksFile(deps.store, base);
        if (isApiError(existing)) return existing;
        if (existing.kind === 'absent' || !existing.file.links[input.itemKey]) {
          return { status: 'already-removed', revision: base };
        }
        if (!canWrite(PATH, 'update')) return apiError('refused:path', 'calendar links path is not allowed');
        const links = { ...existing.file.links };
        delete links[input.itemKey];
        const bytes = serializeCalendarLinksFile({ schema: 1, links });
        try {
          const res = await deps.store.writeFile({
            path: PATH,
            baseCommit: base,
            expect: 'regular-file',
            bytes,
            message: 'Vault Companion: remove calendar link',
            trailers: { [TRAILER_OP]: input.operationId, [TRAILER_PAYLOAD]: await payloadHash(input.raw) },
          });
          if (res.ok) return { status: 'removed', revision: res.commitSha };
          if (res.reason === 'precondition-failed') return apiError('refused:structure', 'the calendar links file is not what this change expects; nothing was written');
        } catch (e) {
          if (e instanceof StoreUnknownOutcome) {
            unknown = true;
            continue;
          }
          const failed = storeFailure(e);
          if (failed) return failed;
          throw e;
        }
      }
      return unknown
        ? apiError('upstream-unavailable', 'GitHub did not confirm the calendar links write; it will be retried safely', true)
        : apiError('conflict:stale', 'the vault kept changing; try again', true);
    },
  };
}
