import type { GameResponse } from '@vault-companion/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { planToasts, seenKey, summaryText } from '../achievements.ts';
import { getGame } from '../api.ts';
import type { QueueItem } from '../queue/queue.ts';
import {
  achievementReward, celebratedIds, diffRewards, earnedByText, newlyEarnedIds, nextBaseline, skillText, withoutCelebrated, xpText,
  type AchievementReward, type RewardEvent,
} from '../rewards.ts';
import { playReward, unlockAudioOnFirstTap } from '../sound.ts';
import './Rewards.css';

// ---- device seen record (shared with the GAM1-C toast plan: same key, same guards) ----------------------------
function readSeen(account: string): readonly string[] | null {
  try {
    const raw = localStorage.getItem(seenKey(account));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return null;
  }
}

function addSeen(account: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  try {
    localStorage.setItem(seenKey(account), JSON.stringify([...new Set([...(readSeen(account) ?? []), ...ids])]));
  } catch {
    // Private mode: the banner still shows, it is just not remembered across opens.
  }
}

// ---- steps: one celebration on screen at a time, small first, the biggest last ------------------------------
type Step =
  | { readonly kind: 'pulse'; readonly xp: Extract<RewardEvent, { kind: 'xp' }> | null; readonly skills: readonly Extract<RewardEvent, { kind: 'skill' }>[] }
  | { readonly kind: 'achievement'; readonly reward: AchievementReward }
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'summary'; readonly text: string }
  | { readonly kind: 'level'; readonly level: number; readonly nextCost: number; readonly title: string | null };

// Banners match their 5 s CSS animation; the level screen closes on any tap before that.
const DURATION: Readonly<Record<Step['kind'], number>> = { pulse: 1700, achievement: 5000, title: 5000, summary: 5000, level: 5500 };

export function toSteps(events: readonly RewardEvent[]): Step[] {
  const steps: Step[] = [];
  const xp = events.find((e) => e.kind === 'xp') ?? null;
  const skills = events.filter((e) => e.kind === 'skill');
  if (xp !== null || skills.length > 0) steps.push({ kind: 'pulse', xp, skills });
  for (const event of events) {
    if (event.kind === 'achievement') steps.push({ kind: 'achievement', reward: event });
    else if (event.kind === 'title') steps.push({ kind: 'title', title: event.title });
    else if (event.kind === 'level') steps.push({ kind: 'level', level: event.level, nextCost: event.nextCost, title: event.title });
  }
  return steps;
}

function soundFor(step: Step): void {
  if (step.kind === 'pulse') playReward(step.xp !== null && step.xp.criticals > 0 ? 'critical' : 'xp');
  else if (step.kind === 'achievement') playReward(step.reward.major ? 'title' : 'achievement');
  else if (step.kind === 'title') playReward('title');
  else if (step.kind === 'level') playReward('level');
}

/** Read again after a save, then once more if the read had not caught up with the commit yet. */
const SETTLE_MS = 600;
const RETRY_MS = 2500;

const levelKey = (account: string, rulesVersion: number): string => `vc.rewards.level.${account}.v${rulesVersion}`;

/** The highest level this device celebrated (or saw on open); null when unknown. Storage errors read as unknown. */
function readMaxLevel(account: string, rulesVersion: number): number | null {
  try {
    const value = Number(localStorage.getItem(levelKey(account, rulesVersion)));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function raiseMaxLevel(account: string, rulesVersion: number, level: number): void {
  try {
    if ((readMaxLevel(account, rulesVersion) ?? 0) < level) localStorage.setItem(levelKey(account, rulesVersion), String(level));
  } catch {
    // Not remembered: a later Undo and redo may replay the level screen once.
  }
}

/**
 * ADR-0064: the reward layer. Mounted once by App on every tab. On open it announces achievements this device has
 * not seen (GAM1-C behaviour, now as banners). After each queued action reaches GitHub it re-reads /api/game, diffs
 * it against the last complete read and plays the celebrations in order. Never takes focus; only the banner and the
 * level screen take a tap. Silent while signed out or when a read fails.
 *
 * Every account session is one generation: a sign-out or account switch clears the queue, the timers and the
 * baseline, and any read or timer from an older generation is ignored. Reads carry a sequence number, so a slow read
 * can never replace a newer baseline; post-save reads wait for the open read first.
 */
export function RewardLayer({ accountKey, signedOut, items, onOpenCharacter }: {
  accountKey: string | null;
  signedOut: boolean;
  items: readonly QueueItem[];
  onOpenCharacter: () => void;
}) {
  const active = !signedOut && accountKey !== null;
  const [current, setCurrent] = useState<Step | null>(null);
  const [stepKey, setStepKey] = useState(0);
  const generation = useRef(0);
  const baseline = useRef<GameResponse | null>(null);
  const savedIds = useRef<Set<string> | null>(null);
  const pending = useRef<Step[]>([]);
  const showing = useRef(false);
  const timers = useRef(new Set<number>());
  const settle = useRef<number | null>(null);
  const readSeq = useRef(0);
  const appliedSeq = useRef(0);
  const openRead = useRef<Promise<void>>(Promise.resolve());

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => { timers.current.delete(id); fn(); }, ms);
    timers.current.add(id);
  }, []);

  const advance = useCallback(() => {
    const next = pending.current.shift() ?? null;
    showing.current = next !== null;
    setCurrent(next);
    setStepKey((k) => k + 1);
    if (next !== null) soundFor(next);
  }, []);

  const enqueue = useCallback((steps: readonly Step[]) => {
    if (steps.length === 0) return;
    pending.current.push(...steps);
    if (!showing.current) advance();
  }, [advance]);

  /** One /api/game read for generation `gen`: null when it failed, belongs to an old generation or was overtaken. */
  const read = useCallback(async (gen: number): Promise<GameResponse | null> => {
    const seq = ++readSeq.current;
    const res = await getGame();
    if (generation.current !== gen || res.kind !== 'ok' || seq < appliedSeq.current) return null;
    appliedSeq.current = seq;
    return res.data;
  }, []);

  useEffect(() => unlockAudioOnFirstTap(), []);

  // Open (and every account change): reset, take the baseline read, announce what this device has not seen.
  useEffect(() => {
    if (!active) return;
    const gen = ++generation.current;
    openRead.current = read(gen).then((game) => {
      if (game === null) return;
      // A partial open read becomes a provisional baseline; the first complete read replaces it without a diff, so
      // the first action after such an open is not celebrated (safe, and rare).
      baseline.current = nextBaseline(baseline.current, game).baseline;
      raiseMaxLevel(accountKey, game.character.rulesVersion, game.character.level);
      const plan = planToasts(game.character.achievements, game.stepMilestones, readSeen(accountKey));
      if (plan.kind === 'summary') enqueue([{ kind: 'summary', text: summaryText(plan.summary) }]);
      if (plan.kind === 'individual') {
        const byId = new Map(game.character.achievements.map((a) => [a.id, a]));
        enqueue(plan.items.flatMap((item) => {
          const a = byId.get(item.id);
          return a ? [{ kind: 'achievement' as const, reward: achievementReward(a, game.feedback) }] : [];
        }));
      }
      if (plan.kind !== 'none') addSeen(accountKey, plan.seenIds);
    }).catch(() => undefined);
    const pendingTimers = timers.current;
    return () => {
      generation.current++;
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.clear();
      if (settle.current !== null) clearTimeout(settle.current);
      settle.current = null;
      baseline.current = null;
      savedIds.current = null;
      pending.current = [];
      showing.current = false;
      setCurrent(null);
    };
  }, [active, accountKey, enqueue, read]);

  const refresh = useCallback(async (gen: number, account: string, attempt: number) => {
    await openRead.current;
    const next = await read(gen);
    if (next === null) return;
    const before = baseline.current;
    // The commit may not be visible yet: wait once, keeping the old baseline.
    if (before !== null && before.revision === next.revision && attempt === 0) {
      later(() => { if (generation.current === gen) void refresh(gen, account, 1); }, RETRY_MS);
      return;
    }
    const { baseline: kept, diff } = nextBaseline(before, next);
    baseline.current = kept;
    if (!diff || before === null) return;
    const seen = readSeen(account) ?? [];
    const rules = next.character.rulesVersion;
    const events = withoutCelebrated(diffRewards(before, next, new Set(seen)), seen, readMaxLevel(account, rules));
    addSeen(account, [...newlyEarnedIds(before, next), ...celebratedIds(events)]);
    raiseMaxLevel(account, rules, next.character.level);
    enqueue(toSteps(events));
  }, [read, later, enqueue]);

  // Every action that newly reaches "saved" schedules one settled re-read (several saves coalesce into one).
  useEffect(() => {
    if (!active) return;
    const saved = items.filter((item) => item.state === 'saved').map((item) => item.operationId);
    if (savedIds.current === null) { savedIds.current = new Set(saved); return; }
    const fresh = saved.filter((id) => !savedIds.current!.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) savedIds.current.add(id);
    if (settle.current !== null) clearTimeout(settle.current);
    const gen = generation.current;
    settle.current = window.setTimeout(() => { settle.current = null; void refresh(gen, accountKey, 0); }, SETTLE_MS);
  }, [items, active, accountKey, refresh]);

  // Auto-advance; a tap on a banner or the level screen advances early.
  useEffect(() => {
    if (current === null) return;
    const timer = window.setTimeout(advance, DURATION[current.kind]);
    return () => clearTimeout(timer);
  }, [current, stepKey, advance]);

  if (!active) return null;
  const open = () => { advance(); onOpenCharacter(); };
  // One always-mounted live region, so a screen reader announces each celebration as it appears.
  return <div className="reward-layer" role="status">
    {current?.kind === 'pulse' && <Pulse key={stepKey} step={current} />}
    {current?.kind === 'achievement' && <AchievementBanner key={stepKey} reward={current.reward} onOpen={open} onDismiss={advance} />}
    {current?.kind === 'title' && <Banner key={stepKey} label="New title" name={current.title} major onOpen={open} onDismiss={advance} />}
    {current?.kind === 'summary' && <Banner key={stepKey} label="Achievements" name={current.text} onOpen={open} onDismiss={advance} />}
    {current?.kind === 'level' && <LevelUp key={stepKey} step={current} onClose={advance} />}
  </div>;
}

function Pulse({ step }: { step: Extract<Step, { kind: 'pulse' }> }) {
  const critical = step.xp !== null && step.xp.criticals > 0;
  return <div className="reward-pulse">
    {step.xp !== null && <span className={`reward-xp motion-fade${critical ? ' is-critical' : ''}`}>{xpText(step.xp)}</span>}
    {step.skills.map((skill) => <span key={skill.profession} className="reward-skill motion-fade">{skillText(skill)}</span>)}
  </div>;
}

function Badge({ major }: { major: boolean }) {
  // A gold medallion with a star: one inline SVG, no image assets.
  return <span className={`reward-badge${major ? ' is-major' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 48 48" width="100%" height="100%">
      <defs>
        <radialGradient id="rb-face" cx="50%" cy="35%" r="65%"><stop offset="0" stopColor="#fff3c4" /><stop offset="0.55" stopColor="#e8b04a" /><stop offset="1" stopColor="#8a5a14" /></radialGradient>
      </defs>
      <circle cx="24" cy="24" r="22" fill="#3a2608" stroke="#f2c86b" strokeWidth="2" />
      <circle cx="24" cy="24" r="17" fill="url(#rb-face)" />
      <path d="M24 12l3.5 7.6 8.3.9-6.2 5.6 1.8 8.2L24 30.2l-7.4 4.1 1.8-8.2-6.2-5.6 8.3-.9z" fill="#fffbe8" stroke="#8a5a14" strokeWidth="1" />
    </svg>
  </span>;
}

function Banner({ label, name, lines = [], points, major = false, onOpen, onDismiss }: {
  label: string;
  name: string;
  lines?: readonly string[];
  points?: number;
  major?: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return <div className={`reward-banner motion-fade${major ? ' is-major' : ''}`}>
    <button type="button" className="reward-banner-main" onClick={onOpen}>
      <Badge major={major} />
      <span className="reward-banner-text">
        <span className="reward-banner-label">{label}</span>
        <span className="reward-banner-name">{name}</span>
        {lines.map((line) => <span key={line} className="reward-banner-line">{line}</span>)}
      </span>
      {points !== undefined && points > 0 && <span className="reward-banner-points"><span aria-hidden="true">{points}</span><span className="reward-sr"> {points} points</span></span>}
    </button>
    <button type="button" className="reward-banner-dismiss" aria-label="Dismiss" onClick={onDismiss}>×</button>
  </div>;
}

function AchievementBanner({ reward, onOpen, onDismiss }: { reward: AchievementReward; onOpen: () => void; onDismiss: () => void }) {
  const lines = [reward.description, earnedByText(reward.earnedBy)].filter((line): line is string => line !== null);
  return <Banner label="Achievement earned" name={reward.name} lines={lines} points={reward.points} major={reward.major} onOpen={onOpen} onDismiss={onDismiss} />;
}

const SPARKS = Array.from({ length: 18 }, (_, i) => i);

function LevelUp({ step, onClose }: { step: Extract<Step, { kind: 'level' }>; onClose: () => void }) {
  return <button type="button" className="reward-level" onClick={onClose}>
    <span className="reward-level-rays" aria-hidden="true" />
    {SPARKS.map((i) => <span key={i} className="reward-level-spark" aria-hidden="true"
      style={{ ['--x' as string]: `${(i * 37) % 100}%`, ['--d' as string]: `${(i % 6) * 0.18}s`, ['--s' as string]: `${0.6 + (i % 4) * 0.25}` }} />)}
    <span className="reward-level-card">
      <span className="reward-level-label">Level up!</span>
      <span className="reward-level-number">{step.level}</span>
      {step.title !== null && <span className="reward-level-title">New title: {step.title}</span>}
      {step.nextCost > 0 && <span className="reward-level-next">Next level in {step.nextCost} XP</span>}
      <span className="reward-level-hint">Tap to continue</span>
    </span>
  </button>;
}
