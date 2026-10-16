import { LeaderboardResponse, LEADERBOARD_MAX_MODELS, LEADERBOARD_TOP_N } from '@vault-companion/contracts';

export type LeaderboardSnapshot = Extract<LeaderboardResponse, { status: 'ok' }>;
export interface StoredLeaderboard {
  readonly version: 1;
  readonly current: LeaderboardSnapshot;
  readonly previous: LeaderboardSnapshot | null;
}
export interface LeaderboardStorage {
  read(): Promise<unknown>;
  write(value: StoredLeaderboard): Promise<void>;
}
/** Structural subset of Workers KV; no Cloudflare dependency in contracts. */
export interface LeaderboardKv {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}
export const LEADERBOARD_STORAGE_KEY = 'leaderboard:v1';
export function createLeaderboardStorage(kv: LeaderboardKv): LeaderboardStorage {
  return {
    read: () => kv.get(LEADERBOARD_STORAGE_KEY, 'json'),
    // One write publishes both snapshots. No partial-page or separate history update.
    write: (value) => kv.put(LEADERBOARD_STORAGE_KEY, JSON.stringify(value)),
  };
}

function snapshot(raw: unknown, now: number): LeaderboardSnapshot | null {
  const parsed = LeaderboardResponse.safeParse(raw);
  if (!parsed.success || parsed.data.status !== 'ok') return null;
  const value = parsed.data;
  const time = Date.parse(value.syncedAt);
  if (!Number.isFinite(time) || time > now + 60_000 || value.models.length > LEADERBOARD_MAX_MODELS) return null;
  const slugs = new Set(value.models.map(m => m.slug));
  if (slugs.size !== value.models.length || slugs.size === 0) return null;
  for (const rows of Object.values(value.rankings)) {
    if (rows.length > LEADERBOARD_TOP_N || new Set(rows).size !== rows.length || rows.some(s => !slugs.has(s))) return null;
  }
  return value;
}
export function parseStoredLeaderboard(raw: unknown, now: number): StoredLeaderboard | null {
  if (typeof raw !== 'object' || raw === null || !('version' in raw) || raw.version !== 1 || !('current' in raw) || !('previous' in raw)) return null;
  const current = snapshot(raw.current, now);
  const previous = raw.previous === null ? null : snapshot(raw.previous, now);
  if (!current || (raw.previous !== null && !previous) || (previous && Date.parse(previous.syncedAt) >= Date.parse(current.syncedAt))) return null;
  return { version: 1, current, previous };
}
