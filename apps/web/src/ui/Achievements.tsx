import type { GameAchievement, GameResponse } from '@vault-companion/contracts';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CopyView } from '../lastCopy.ts';
import { shortDate } from '../character.ts';
import {
  addPin,
  chainLabel,
  detailProgress,
  displayName,
  displayPoints,
  formatStepMilestones,
  groupByCategory,
  isHiddenUnearned,
  PIN_LIMIT,
  removePin,
  tileProgress,
  totalPoints,
} from '../achievements.ts';
import { earnedByText } from '../rewards.ts';
import { achievementQuality, categoryGlyph, lockedArc, qualityForPoints, qualityLabel, remainingText } from '../character-skin.ts';
import { Medal } from './CharacterGlyphs.tsx';
import { CopyNote } from './useLastCopy.tsx';
import { SheetHeader } from './SheetHeader.tsx';
import './Achievements.css';

export interface TogglePinResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** The domain sends lower-case profession ids as categories ("athletics"); the detail names them as words. */
const categoryWord = (category: string): string => category.charAt(0).toUpperCase() + category.slice(1);

function tileLabel(achievement: GameAchievement): string {
  if (isHiddenUnearned(achievement)) return 'Hidden achievement';
  const earned = achievement.earned ? ', earned' : '';
  return `${displayName(achievement)}, ${displayPoints(achievement)} points${earned}`;
}

/**
 * One tile in the 4-column grid, icon first (R4): the framed category glyph, lit in the tier's quality colour when
 * earned, grey with a progress arc when not; the name in serif below, then points and the tile's progress. A hidden
 * unearned tile is a single "?" in the frame: no name, points or progress.
 */
function AchievementTile({ achievement, all, onOpen }: {
  achievement: GameAchievement;
  all: readonly GameAchievement[];
  onOpen: (achievement: GameAchievement, from: HTMLElement) => void;
}) {
  const hidden = isHiddenUnearned(achievement);
  const progress = tileProgress(achievement, all);
  const earned = achievement.earned;
  const meta = [progress, achievement.type === 'meta' ? 'Meta' : null].filter((part) => part !== null);
  return <button type="button" data-testid="achievement-tile" data-achievement={achievement.id}
    data-quality={hidden ? undefined : achievementQuality(achievement)}
    className={`achievement-tile${earned ? ' is-earned' : ''}${hidden ? ' is-hidden' : ''}`}
    aria-label={tileLabel(achievement)} onClick={(event) => onOpen(achievement, event.currentTarget)}>
    <Medal glyph={categoryGlyph(achievement.category)} lit={earned} arc={lockedArc(achievement)} hidden={hidden} />
    {!hidden && <>
      <span className="achievement-tile-name">{displayName(achievement)}</span>
      <span className="achievement-tile-points">{displayPoints(achievement)} pts{meta.map((part) => <span key={part} className="achievement-tile-progress"> · {part}</span>)}</span>
    </>}
  </button>;
}

function CategorySection({ category, earned, total, achievements, all, onOpen }: {
  category: string;
  earned: number;
  total: number;
  achievements: readonly GameAchievement[];
  all: readonly GameAchievement[];
  onOpen: (achievement: GameAchievement, from: HTMLElement) => void;
}) {
  return <section className="achievements-category" data-testid="achievement-category">
    <h3 className="achievements-heading"><span>{categoryWord(category)} <span className="achievements-count">· {earned} / {total}</span></span></h3>
    <div className="achievements-grid">
      {achievements.map((achievement) => <AchievementTile key={achievement.id} achievement={achievement} all={all} onOpen={onOpen} />)}
    </div>
  </section>;
}

/** Feats of Strength: listed separately, always 0 pts, never part of any total. */
function FeatsSection({ feats, all, onOpen }: {
  feats: readonly GameAchievement[];
  all: readonly GameAchievement[];
  onOpen: (achievement: GameAchievement, from: HTMLElement) => void;
}) {
  if (feats.length === 0) return null;
  return <section className="achievements-category" data-testid="achievement-feats">
    <h3 className="achievements-heading"><span>Feats of Strength <span className="achievements-count">· 0 pts</span></span></h3>
    <div className="achievements-grid">
      {feats.map((feat) => <AchievementTile key={feat.id} achievement={feat} all={all} onOpen={onOpen} />)}
    </div>
  </section>;
}

/** The Walking step milestones: NEXT with a progress bar, EARNED newest first, points only. Never shows a zero. */
function WalkingSection({ milestones, today }: { milestones: GameResponse['stepMilestones']; today: string }) {
  const view = formatStepMilestones(milestones);
  if (!view.available) {
    return <section className="achievements-category" data-testid="achievement-walking">
      <h3 className="achievements-heading">Walking</h3>
      <p className="muted">Steps unavailable.</p>
      <p className="achievements-note">Points only, no XP · no daily goal, no streak</p>
    </section>;
  }
  return <section className="achievements-category" data-testid="achievement-walking">
    <h3 className="achievements-heading">Walking</h3>
    {view.next !== null && <div className="achievements-next">
      <div className="achievements-next-head"><span>NEXT</span><span>{view.next.name}</span></div>
      <span className="achievements-bar" role="img" aria-label={`${view.next.name}: ${view.next.label}`}>
        <span style={{ width: `${view.next.percent}%` }} />
      </span>
      <div className="achievements-next-label">{view.next.label}</div>
    </div>}
    {view.earned.length > 0 && <div className="achievements-earned">
      <h4>EARNED</h4>
      <ul>
        {view.earned.map((milestone) => <li key={milestone.id} data-quality={qualityForPoints(milestone.points)}>
          <Medal glyph={categoryGlyph('journey')} lit className="is-small" />
          <span className="achievements-earned-name">{milestone.name}</span>
          <span className="achievements-earned-meta">{milestone.points} pts · {shortDate(milestone.earnedDate, today)}</span>
        </li>)}
      </ul>
    </div>}
    <p className="achievements-note">Points only, no XP · no daily goal, no streak</p>
  </section>;
}

/** Screen 4: the badge detail sheet. Close/Escape return focus to the tile that opened it. */
function AchievementDetail({ achievement, all, feedback, today, pinned, onTogglePin, onClose, returnTo }: {
  achievement: GameAchievement;
  all: readonly GameAchievement[];
  feedback: GameResponse['feedback'];
  today: string;
  pinned: boolean;
  onTogglePin: (id: string) => TogglePinResult;
  onClose: () => void;
  returnTo: HTMLElement | null;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const hidden = isHiddenUnearned(achievement);
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus({ preventScroll: true });
    return () => { if (returnTo !== null && returnTo.isConnected) returnTo.focus(); };
  }, [returnTo]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    const controls = sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
    const first = controls?.[0];
    const last = controls !== undefined && controls.length > 0 ? controls[controls.length - 1] : undefined;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const chain = hidden ? null : chainLabel(achievement, all);
  const progress = hidden ? null : detailProgress(achievement);
  // ADR-0064: what it asks, and what earned it. A hidden achievement keeps its secret until earned.
  const extra = hidden ? undefined : feedback?.achievements[achievement.id];
  const earnedBy = earnedByText(extra?.earnedBy ?? null);
  const earnedDate = achievement.earned && achievement.earnedDate !== null ? shortDate(achievement.earnedDate, today) : null;
  const quality = achievementQuality(achievement);
  const points = displayPoints(achievement);
  const left = remainingText(achievement);
  const kind = [categoryWord(achievement.category), achievement.type === 'meta' ? 'Meta' : null, chain]
    .filter((part) => part !== null).join(' · ');
  // R4: the WoW tooltip moment. The name in the tier colour (header), what kind it is, what it asks, how it was
  // earned or what is left, the points shield and the date. A hidden achievement keeps every secret.
  return <div className="sheet-backdrop" role="presentation">
    <div ref={sheet} className="sheet achievement-detail character-skin" role="dialog" aria-modal="true"
      data-quality={hidden ? undefined : quality}
      aria-label={hidden ? 'Hidden achievement' : displayName(achievement)} onKeyDown={onKeyDown}>
      <SheetHeader title={hidden ? '?' : displayName(achievement)} onClose={onClose} />
      <div className="achievement-detail-body">
        <div className="achievement-detail-head">
          <Medal glyph={categoryGlyph(achievement.category)} lit={achievement.earned} arc={lockedArc(achievement)} hidden={hidden} className="is-large" />
          <p className="achievement-detail-kind">{hidden ? 'Hidden achievement' : <><span className="achievement-detail-quality">{qualityLabel(quality)}</span><br />{kind}</>}</p>
          {!hidden && (achievement.type === 'feat'
            ? <span className="achievement-detail-feat">Feat of Strength</span>
            : <span className="achievement-shield">
              <svg viewBox="0 0 40 44" aria-hidden="true" focusable="false"><path d="M20 2 37 8v13c0 10-7 17.5-17 21C10 38.5 3 31 3 21V8z" /></svg>
              <span className="achievement-shield-points">{points}</span> <span className="achievement-shield-unit">pts</span>
            </span>)}
        </div>
        {extra !== undefined && <p className="achievement-detail-description">{extra.description}</p>}
        {earnedDate !== null && <p className="achievement-detail-earned" data-testid="achievement-earned-line">
          <span>{earnedBy ?? 'Earned'}</span><span className="achievement-detail-date">{earnedDate}</span>
        </p>}
        {progress !== null && <div className="achievement-detail-progress">
          <span className="achievements-bar" role="img" aria-label={`${achievement.name}: ${progress.label}`}><span style={{ width: `${progress.percent}%` }} /></span>
          <span className="achievement-detail-left">{[progress.label, left].filter((part) => part !== null).join(' · ')}</span>
        </div>}
        {!achievement.earned && achievement.locked && achievement.lockedReason !== null && <p className="achievement-detail-locked">{achievement.lockedReason}</p>}
        <button type="button" className="achievement-pin"
          onClick={() => { const result = onTogglePin(achievement.id); setNote(result.ok ? null : result.reason ?? null); }}>
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        {note !== null && <p className="achievement-pin-note" role="status">{note}</p>}
      </div>
    </div>
  </div>;
}

/**
 * Screen 3: the Achievements page, rendered as a page inside the Character sheet (never its own dialog). The header's
 * trailing control shows the earned total (feats excluded) and returns to the overview, as do Back and Escape.
 */
export function AchievementsPage({ data, view, retry, onBack, pinnedIds, onPinsChange }: {
  data: GameResponse | null;
  view: CopyView<GameResponse>;
  retry: () => void;
  onBack: () => void;
  pinnedIds: readonly string[];
  onPinsChange: (next: readonly string[]) => void;
}) {
  const [detail, setDetail] = useState<{ achievement: GameAchievement; from: HTMLElement | null } | null>(null);
  const groups = data !== null ? groupByCategory(data.character.achievements) : [];
  const feats = data?.character.feats ?? [];
  const points = data !== null ? totalPoints(data.character.achievements) : 0;
  const today = data?.now.slice(0, 10) ?? '';
  const empty = data !== null && groups.length === 0 && feats.length === 0;
  const onTogglePin = (id: string): TogglePinResult => {
    if (pinnedIds.includes(id)) { onPinsChange(removePin(pinnedIds, id)); return { ok: true }; }
    const result = addPin(pinnedIds, id, PIN_LIMIT);
    if (!result.ok) return { ok: false, reason: result.reason };
    onPinsChange(result.pinnedIds);
    return { ok: true };
  };
  return <>
    <SheetHeader title="Achievements" onClose={onBack} closeLabel={data !== null ? `${points} pts` : 'Close'} onBack={onBack} backLabel="Character" />
    <CopyNote view={view} />
    {data === null && <div className="character-card-empty">
      <p className="muted">{view.res === null ? 'Loading…' : 'Character could not be loaded.'}</p>
      {view.res !== null && <button type="button" onClick={retry}>Retry</button>}
    </div>}
    {data !== null && <div className="achievements-content">
      {empty
        ? <p className="muted" data-testid="achievements-empty">No achievements yet</p>
        : <>
          {groups.map((group) => <CategorySection key={group.category} category={group.category} earned={group.earned} total={group.total}
            achievements={group.achievements} all={data.character.achievements} onOpen={(achievement, from) => setDetail({ achievement, from })} />)}
          <FeatsSection feats={feats} all={data.character.achievements} onOpen={(achievement, from) => setDetail({ achievement, from })} />
          <WalkingSection milestones={data.stepMilestones} today={today} />
        </>}
    </div>}
    {detail !== null && data !== null && <AchievementDetail achievement={detail.achievement} all={data.character.achievements} feedback={data.feedback} today={today}
      pinned={pinnedIds.includes(detail.achievement.id)} onTogglePin={onTogglePin} returnTo={detail.from} onClose={() => setDetail(null)} />}
  </>;
}

