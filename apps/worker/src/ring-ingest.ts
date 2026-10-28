import { HEALTH_VITALS_DAILY_CSV, ringSlotsPath } from '@vault-companion/contracts';
import {
  affectedDates, canonicalSlotStart, canWrite, DEFAULT_USER_TIME_ZONE, deriveRingDaily, executeWrite, FileTooLarge,
  mergeDailyFile, mergeSlotFile, parseRingPayload, parseSlotFile, parseVaultPath, ringStructureRefusal, splitByMonth,
  StoreUnavailable, StoreUnknownOutcome, type HealthIngestDeps, type RingFileMerge, type RingSlot,
  type VaultPath, type VaultStore, type WritePlan,
} from '@vault-companion/domain';

export type RingIngestOutcome =
  | { ok: true; slots: number; months: string[]; days: string[] }
  | { ok: false; status: 400 | 409 | 422 | 503; error: string };
const UNCHANGED = 'ring bytes unchanged';
const MAX_DAILY_WINDOW_PASSES = 16;
const refuse = (message: string) => ({ ok: false, code: 'refused:structure', message } as const);
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');

async function read(store: VaultStore, path: VaultPath, at: string) {
  const file = await store.readFile(path, at);
  if (!file) return null;
  if (file.bytes.length > 1024 * 1024) throw new FileTooLarge('ring file too large');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); }
  catch { throw new FileTooLarge('ring file encoding'); }
}

// Calendar neighbours are independent of DST.
function windowFor(dates: readonly string[]): Set<string> {
  return new Set(dates.flatMap((d) => [-1, 0, 1].map((offset) =>
    new Date(Date.parse(`${d}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10))));
}

export function createRingIngestService(deps: HealthIngestDeps) {
  const { store } = deps, tz = deps.timeZone ?? DEFAULT_USER_TIME_ZONE;
  return { async ingestRing(body: string): Promise<RingIngestOutcome> {
    const parsed = parseRingPayload(body, deps.now?.() ?? new Date(), tz);
    if (!parsed.ok) return parsed;
    const grouped = splitByMonth(parsed.slots, tz), months = [...grouped.keys()];
    let days: string[] = [], kind = 'ring slots';
    const failure = (status: 409 | 503): RingIngestOutcome => ({ ok: false, status, error: `${kind}: ${status === 503 ? 'write unavailable; resend' : 'write refused; resend'}` });
    async function write(pathText: string, prefix: string, merge: (s: VaultStore, at: string, text: string | null) => Promise<RingFileMerge>) {
      const path = parseVaultPath(pathText);
      if (!path) return failure(409);
      const cache = new Map<string, ReturnType<WritePlan<null>['compute']>>();
      const plan: WritePlan<null> = { message: `health: ingest ${kind}`, compute(s, at) {
        const cached = cache.get(at);
        if (cached) return cached;
        const result = (async (): ReturnType<WritePlan<null>['compute']> => {
          const text = await read(s, path, at), expect = text === null ? 'absent' : 'regular-file';
          if (!canWrite(path, expect === 'absent' ? 'create' : 'update')) return refuse('ring path refused');
          const merged = await merge(s, at, text);
          if (!merged.ok) return merged;
          if (!merged.changed) return refuse(UNCHANGED);
          return { ok: true, path, expect, bytes: new TextEncoder().encode(merged.text), effect: null };
        })();
        cache.set(at, result);
        return result;
      } };
      const revision = (await store.head()).commitSha, planned = await plan.compute(store, revision);
      if (!planned.ok) return planned.message === UNCHANGED ? null : failure(409);
      const payloadHash = await hash(`${path}\n${new TextDecoder().decode(planned.bytes)}`);
      const result = await executeWrite(store, { baseRevision: revision, payloadHash, operationId: `${prefix}:${payloadHash.slice(0, 32)}` }, plan);
      if (result.ok || result.message === UNCHANGED) return null;
      return failure(result.code === 'upstream-unavailable' || result.code === 'conflict:stale' ? 503 : 409);
    }
    try {
      for (const [month, slots] of grouped) {
        const failed = await write(ringSlotsPath(month), `ring-slots:${month}`, async (_s, _at, text) => mergeSlotFile(text, slots, parsed.version, tz));
        if (failed) return failed;
      }
      if (!parsed.slots.length) return { ok: true, slots: 0, months, days };
      kind = 'ring daily';
      const failed = await write(HEALTH_VITALS_DAILY_CSV, 'ring-daily', async (s, at, text) => {
        let slots: RingSlot[] = [];
        days = affectedDates(parsed.slots, parsed.slots, tz);
        let window = windowFor(days);
        const sources = new Map<string, string | null>();
        // Reload the expanded window at this attempt's revision if a night reaches another date.
        for (let pass = 0; ; pass++) {
          // A window that keeps widening means the stored structure is not what the daily rules expect.
          if (pass === MAX_DAILY_WINDOW_PASSES) return ringStructureRefusal;
          slots = [];
          for (const month of [...new Set([...window].map((d) => d.slice(0, 7)))].sort()) {
            if (!sources.has(month)) sources.set(month, await read(s, ringSlotsPath(month) as VaultPath, at));
            const source = sources.get(month)!;
            if (source === null) continue;
            const file = parseSlotFile(source, (instant) => !Number.isFinite(instant) || window.has(canonicalSlotStart(instant, tz).slice(0, 10)));
            if (!file.ok) return file;
            slots.push(...file.slots);
          }
          days = affectedDates(parsed.slots, slots, tz);
          if (days.every((d) => window.has(d))) break;
          window = new Set([...window, ...windowFor(days)]);
        }
        return mergeDailyFile(text, deriveRingDaily(slots, days, tz));
      });
      return failed ?? { ok: true, slots: parsed.slots.length, months, days };
    } catch (e) {
      if (e instanceof FileTooLarge) return failure(409);
      if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return failure(503);
      throw e;
    }
  } };
}
