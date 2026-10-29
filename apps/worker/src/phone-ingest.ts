import { phoneSlotsPath } from '@vault-companion/contracts';
import {
  aggregatePhoneSlots, canWrite, createHealthIngestService, DEFAULT_USER_TIME_ZONE, executeWrite, FileTooLarge,
  mergePhoneSlotFile, parsePhoneV2, parseVaultPath, PHONE_SCHEMAS, planHealthDaily, splitPhoneSlotsByMonth,
  type HealthIngestDeps, type HealthIngestOutcome, type HealthSamples, type Planned, type WritePlan,
} from '@vault-companion/domain';

export type PhoneIngestOutcome = HealthIngestOutcome | { ok: true; days: readonly string[]; slots: number; months: string[]; commitSha: string };
const UNCHANGED = 'phone bytes unchanged';
const refuse = (message: string) => ({ ok: false, code: 'refused:structure', message } as const);
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');

export function createPhoneIngestService(deps: HealthIngestDeps) {
  const v1 = createHealthIngestService(deps), { store } = deps, tz = deps.timeZone ?? DEFAULT_USER_TIME_ZONE;
  return { async ingestHealth(body: string): Promise<PhoneIngestOutcome> {
    // Preserve even v1's whitespace-key handling and diagnostics verbatim.
    let version: unknown;
    try { version = (JSON.parse(body) as { schemaVersion?: unknown } | null)?.schemaVersion; } catch { /* v1 diagnoses JSON */ }
    if (version !== 2) return v1.ingestHealth(body);
    const parsed = parsePhoneV2(body, deps.now?.() ?? new Date(), tz);
    if (!parsed.ok) return parsed;
    const select = (key: string) => parsed.samples.filter((s) => s.key === key);
    const samples: HealthSamples = {
      steps: select('steps'), distance: select('distance'), flights: select('flights'), activeEnergy: select('activeEnergy'),
      walkingSpeed: select('walkingSpeed'), headphone: select('headphone'),
      sleep: select('inBed').map((s) => ({ ...s, inBed: s.inBed === true })),
    };
    const daily = planHealthDaily(parsed.from, parsed.sentAt, samples, tz);
    if (!daily.ok) return daily;
    const slots = aggregatePhoneSlots(parsed.samples, parsed.from, parsed.sentAt, tz);
    const grouped = splitPhoneSlotsByMonth(slots, tz), months = [...grouped.keys()].sort();
    let kind = 'phone slots', commitSha = '';
    const failure = (status: 409 | 503): PhoneIngestOutcome => ({ ok: false, status, error: `${kind}: write ${status === 503 ? 'unavailable' : 'refused'}; resend` });
    // Cache by immutable commit only; a CAS retry must read and merge at its new commit.
    function cached<E>(plan: WritePlan<E>): WritePlan<E> {
      const cache = new Map<string, Promise<Planned<E>>>();
      return { ...plan, compute(s, at) {
        let result = cache.get(at);
        if (!result) { result = plan.compute(s, at); cache.set(at, result); }
        return result;
      } };
    }
    try {
      const plans = months.map((month) => {
        const path = parseVaultPath(phoneSlotsPath(month));
        return cached<null>({ message: 'health: ingest phone slots', async compute(s, at) {
          if (!path) return refuse('phone path refused');
          const file = await s.readFile(path, at), expect = file ? 'regular-file' : 'absent';
          if (!canWrite(path, file ? 'update' : 'create')) return refuse('phone path refused');
          if (file && file.bytes.length > 1024 * 1024) return refuse('phone file size');
          let text: string | null = null;
          try { if (file) text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); }
          catch { return refuse('phone file encoding'); }
          const merged = mergePhoneSlotFile(text, grouped.get(month)!, Math.max(...Object.values(PHONE_SCHEMAS)), tz, 'replace');
          if (!merged.ok) return merged;
          if (!merged.changed) return refuse(UNCHANGED);
          return { ok: true, path, expect, bytes: new TextEncoder().encode(merged.text), effect: null };
        } });
      });
      // Whole-request structure refusal, including a malformed later month, before the first write.
      const initial = (await store.head()).commitSha;
      for (const plan of plans) {
        const p = await plan.compute(store, initial);
        if (!p.ok && p.message !== UNCHANGED) return failure(409);
      }
      async function write<E>(plan: WritePlan<E>, prefix: string, bodyHash?: string) {
        const revision = (await store.head()).commitSha, p = await plan.compute(store, revision);
        if (!p.ok) return p.message === UNCHANGED ? null : failure(409);
        const payloadHash = bodyHash ?? await hash(`${p.path}\n${new TextDecoder().decode(p.bytes)}`);
        const result = await executeWrite(store, { baseRevision: revision, payloadHash, operationId: `${prefix}:${payloadHash.slice(0, 32)}` }, plan);
        if (result.ok) { commitSha = result.commitSha; return null; }
        if (result.message === UNCHANGED) return null;
        return failure(result.code === 'upstream-unavailable' || result.code === 'conflict:stale' ? 503 : 409);
      }
      for (const [i, month] of months.entries()) {
        const failed = await write(plans[i]!, `phone-slots:${month}`);
        if (failed) return failed;
      }
      kind = 'health daily';
      const plan = cached({ ...daily.plan, async compute(s, at) {
        commitSha = at;
        const p = await daily.plan.compute(s, at);
        if (!p.ok) return p;
        const current = await s.readFile(p.path, at);
        if (current && current.bytes.length === p.bytes.length && current.bytes.every((b, i) => b === p.bytes[i])) return refuse(UNCHANGED);
        return p;
      } });
      const failed = await write(plan, 'health-ingest', await hash(body));
      return failed ?? { ok: true, days: daily.days, slots: slots.length, months, commitSha };
    } catch (e) {
      // Adapter exceptions can contain source data. Expose only the file kind, never exception text.
      return failure(e instanceof FileTooLarge ? 409 : 503);
    }
  } };
}
