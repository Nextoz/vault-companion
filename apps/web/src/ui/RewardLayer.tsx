import type { GameResponse } from '@vault-companion/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { planToasts, seenKey, summaryText } from '../achievements.ts';
import { getGame } from '../api.ts';
import type { QueueItem } from '../queue/queue.ts';
import { achievementReward, diffRewards, earnedByText, newlyEarnedIds, skillText, xpText, type AchievementReward, type RewardEvent } from '../rewards.ts';
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

const DURATION: Readonly<Record<Step['kind'], number>> = { pulse: 1700, achievement: 4800, title: 4200, summary: 4000, level: 6500 };

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

/**
 * ADR-0064: the reward layer. Mounted once by App on every tab. On open it announces achievements this device has
 * not seen (GAM1-C behaviour, now as banners). After each queued action reaches GitHub it re-reads /api/game, diffs
 * it against the previous read and plays the celebrations in order. Never takes focus; only the banner and the level
 * screen take a tap. Silent while signed out or when a read fails.
 */
export function RewardLayer({ accountKey, signedOut, items, onOpenCharacter }: {
  accountKey: string | null;
  signedOut: boolean;
  items: readonly QueueItem[];
  onOpenCharacter: () => void;
}) {
  const baseline = useRef<GameResponse | null>(null);
  const savedIds = useRef<Set<string> | null>(null);
  const pending = useRef<Step[]>([]);
  const [current, setCurrent] = useState<Step | null>(null);
  const [stepKey, setStepKey] = useState(0);
  const timers = useRef<number[]>([]);
  const active = !signedOut && accountKey !== null;

  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  const showing = useRef(false);
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

  useEffect(() => unlockAudioOnFirstTap(), []);
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);

  // Open: the baseline read, plus the unseen-on-this-device announcement.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    baseline.current = null;
    savedIds.current = null;
    void getGame().then((res) => {
      if (cancelled || res.kind !== 'ok') return;
      baseline.current = res.data;
      const plan = planToasts(res.data.character.achievements, res.data.stepMilestones, readSeen(accountKey));
      if (plan.kind === 'summary') enqueue([{ kind: 'summary', text: summaryText(plan.summary) }]);
      if (plan.kind === 'individual') {
        const byId = new Map(res.data.character.achievements.map((a) => [a.id, a]));
        enqueue(plan.items.flatMap((item) => {
          const a = byId.get(item.id);
          return a ? [{ kind: 'achievement' as const, reward: achievementReward(a, res.data.feedback) }] : [];
        }));
      }
      if (plan.kind !== 'none') addSeen(accountKey, plan.seenIds);
    });
    return () => { cancelled = true; };
  }, [active, accountKey, enqueue]);

  const refresh = useCallback((attempt: number) => {
    if (!active) return;
    void getGame().then((res) => {
      if (res.kind !== 'ok') return;
      const before = baseline.current;
      baseline.current = res.data;
      if (before === null) return;
      if (before.revision === res.data.revision && attempt === 0) {
        baseline.current = before;
        later(() => refresh(1), RETRY_MS);
        return;
      }
      addSeen(accountKey, newlyEarnedIds(before, res.data));
      enqueue(toSteps(diffRewards(before, res.data)));
    });
  }, [active, accountKey, enqueue]);

  // Every action that newly reaches "saved" schedules one settled re-read (several saves coalesce into one).
  const settle = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const saved = items.filter((item) => item.state === 'saved').map((item) => item.operationId);
    if (savedIds.current === null) { savedIds.current = new Set(saved); return; }
    const fresh = saved.filter((id) => !savedIds.current!.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) savedIds.current.add(id);
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = window.setTimeout(() => { settle.current = null; refresh(0); }, SETTLE_MS);
  }, [items, active, refresh]);

  // Auto-advance; a tap on a banner or the level screen advances early.
  useEffect(() => {
    if (current === null) return;
    const timer = window.setTimeout(advance, DURATION[current.kind]);
    return () => clearTimeout(timer);
  }, [current, stepKey, advance]);

  if (!active || current === null) return null;
  const open = () => { advance(); onOpenCharacter(); };
  return <div className="reward-layer" aria-live="polite">
    {current.kind === 'pulse' && <Pulse key={stepKey} step={current} />}
    {current.kind === 'achievement' && <AchievementBanner key={stepKey} reward={current.reward} onOpen={open} onDismiss={advance} />}
    {current.kind === 'title' && <Banner key={stepKey} label="New title" name={current.title} major onOpen={open} onDismiss={advance} />}
    {current.kind === 'summary' && <Banner key={stepKey} label="Achievements" name={current.text} onOpen={open} onDismiss={advance} />}
    {current.kind === 'level' && <LevelUp key={stepKey} step={current} onClose={advance} />}
  </div>;
}

function Pulse({ step }: { step: Extract<Step, { kind: 'pulse' }> }) {
  const critical = step.xp !== null && step.xp.criticals > 0;
  return <div className="reward-pulse" role="status">
    {step.xp !== null && <span className={`reward-xp${critical ? ' is-critical' : ''}`}>{xpText(step.xp)}</span>}
    {step.skills.map((skill) => <span key={skill.profession} className="reward-skill">{skillText(skill)}</span>)}
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
  return <div className={`reward-banner${major ? ' is-major' : ''}`} role="status">
    <button type="button" className="reward-banner-main" onClick={onOpen} aria-label={`${label}: ${name}`}>
      <Badge major={major} />
      <span className="reward-banner-text">
        <span className="reward-banner-label">{label}</span>
        <span className="reward-banner-name">{name}</span>
        {lines.map((line) => <span key={line} className="reward-banner-line">{line}</span>)}
      </span>
      {points !== undefined && points > 0 && <span className="reward-banner-points" aria-label={`${points} points`}>{points}</span>}
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
  return <button type="button" className="reward-level" onClick={onClose} aria-label={`Level ${step.level} reached. Tap to continue`}>
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
