// Cached NOAA SWPC adapter for the sky monitor (M7). One fixed public URL, fetched server-side; the parsed rows are
// cached and re-projected on every read because "current slot" moves while the rows do not.
import { KP_SOURCE_URL, SKY_REASON_NOTES, type KpPoint, type SkyResponse, type SkyUnavailableReason, type WeatherFailureReason } from '@vault-companion/contracts';
import { readJson } from './weather-provider.ts';

export const SKY_FETCH_TIMEOUT_MS = 8_000;
/** The forecast file changes a few times a day: rows are fresh for 30 minutes. */
export const SKY_CACHE_TTL_MS = 30 * 60_000;

const SLOT_MS = 3 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
const TIME_TAG = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const KINDS = new Set(['observed', 'estimated', 'predicted']);

/** Strict reader: an array of `{ time_tag (UTC, no zone), kp 0..9, observed }`; 3-hour boundaries, strictly increasing. */
export function parseKpBody(body: unknown): KpPoint[] | null {
  if (!Array.isArray(body)) return null;
  const out: KpPoint[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const row of body) {
    if (typeof row !== 'object' || row === null) return null;
    const r = row as Record<string, unknown>;
    if (typeof r.time_tag !== 'string' || !TIME_TAG.test(r.time_tag)) return null;
    const ms = Date.parse(`${r.time_tag}Z`);
    if (!Number.isFinite(ms) || ms % SLOT_MS !== 0 || ms <= previous) return null;
    if (typeof r.kp !== 'number' || !Number.isFinite(r.kp) || r.kp < 0 || r.kp > 9) return null;
    if (typeof r.observed !== 'string' || !KINDS.has(r.observed)) return null;
    previous = ms;
    out.push({ time: new Date(ms).toISOString(), kp: r.kp, kind: r.observed as KpPoint['kind'] });
  }
  return out;
}

export function projectSky(points: readonly KpPoint[], now: Date, fetchedAt: string): SkyResponse {
  const nowMs = now.getTime();
  const kept = points.filter((p) => Date.parse(p.time) >= nowMs - DAY_MS);
  if (kept.length === 0) return { status: 'unavailable', now: now.toISOString(), reason: 'empty', note: SKY_REASON_NOTES.empty };
  const current = kept.find((p) => Date.parse(p.time) <= nowMs && nowMs < Date.parse(p.time) + SLOT_MS) ?? null;
  let next24hMax: KpPoint | null = null;
  for (const p of kept) {
    const start = Date.parse(p.time);
    if (start + SLOT_MS <= nowMs || start >= nowMs + DAY_MS) continue;
    if (next24hMax === null || p.kp > next24hMax.kp) next24hMax = p;
  }
  return { status: 'ok', now: now.toISOString(), fetchedAt, points: kept, current, next24hMax };
}

export interface SkyProviderDeps {
  readonly fetch: typeof fetch;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
}

const toSkyReason = (reason: WeatherFailureReason): SkyUnavailableReason =>
  reason === 'timeout' || reason === 'malformed' || reason === 'provider-error' ? reason : 'provider-error';

export function createSkyProvider(deps: SkyProviderDeps) {
  const timeoutMs = deps.timeoutMs ?? SKY_FETCH_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? SKY_CACHE_TTL_MS;
  let cache: { at: number; points: readonly KpPoint[] } | null = null;
  let inflight: Promise<SkyResponse> | null = null;

  const project = (entry: { at: number; points: readonly KpPoint[] }, nowMs: number): SkyResponse =>
    projectSky(entry.points, new Date(nowMs), new Date(entry.at).toISOString());

  const refresh = async (nowMs: number): Promise<SkyResponse> => {
    const res = await readJson(deps.fetch, KP_SOURCE_URL, timeoutMs);
    const points = res.ok ? parseKpBody(res.body) : null;
    if (!res.ok || points === null) {
      // A failed refresh reuses the last rows with their ORIGINAL fetchedAt: visible stale, never repainted fresh.
      if (cache) return project(cache, nowMs);
      const reason: SkyUnavailableReason = res.ok ? 'malformed' : toSkyReason(res.reason);
      return { status: 'unavailable', now: new Date(nowMs).toISOString(), reason, note: SKY_REASON_NOTES[reason] };
    }
    cache = { at: nowMs, points };
    return project(cache, nowMs);
  };

  return {
    async read(): Promise<SkyResponse> {
      const nowMs = deps.now();
      if (cache && nowMs - cache.at < cacheTtlMs) return project(cache, nowMs);
      inflight ??= refresh(nowMs).finally(() => { inflight = null; });
      return inflight;
    },
  };
}
