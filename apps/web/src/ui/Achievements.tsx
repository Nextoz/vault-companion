import type { GameAchievement, GameResponse, GameStepMilestones } from '@vault-companion/contracts';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  categoryPoints,
  createPinState,
  displayName,
  displayPoints,
  formatStepMilestones,
  groupByCategory,
  isEarnedTile,
  isHiddenUnearned,
  progressText,
  totalPoints,
} from '../achievements.ts';
import { SheetHeader } from './SheetHeader.tsx';
import { shortDate } from '../character.ts';

/** Achievement tile button props. */
interface AchievementTileProps {
  achievement: GameAchievement;
  onClick: () => void;
}

/** A single achievement tile in the grid. */
function AchievementTile({ achievement, onClick }: AchievementTileProps) {
  const earned = isEarnedTile(achievement);
  const hidden = isHiddenUnearned(achievement);
  const progress = progressText(achievement);

  return (
    <button
      type="button"
      className={`achievement-tile ${earned ? 'earned' : ''} ${hidden ? 'hidden' : ''}`}
      onClick={onClick}
      aria-label={`${displayName(achievement)}, ${displayPoints(achievement)} points${earned ? ', earned' : ''}${progress ? `, ${progress}` : ''}`}
    >
      <div className="achievement-tile-name">{displayName(achievement)}</div>
      <div className="achievement-tile-points">{displayPoints(achievement)} pts</div>
      {progress && !hidden && <div className="achievement-tile-progress">{progress}</div>}
      {achievement.type === 'chain' && achievement.tier !== null && !hidden && (
        <div className="achievement-tile-tier">Tier {achievement.tier + 1}</div>
      )}
      {achievement.type === 'meta' && !hidden && <div className="achievement-tile-meta">Meta</div>}
    </button>
  );
}

/** Category section with grid of achievement tiles. */
function CategorySection({
  category,
  earned,
  total,
  achievements,
  onOpenAchievement,
}: {
  category: string;
  earned: number;
  total: number;
  achievements: readonly GameAchievement[];
  onOpenAchievement: (a: GameAchievement) => void;
}) {
  return (
    <section className="achievements-category">
      <h3 className="achievements-category-header">
        {category} · {earned} / {total}
      </h3>
      <div className="achievements-grid">
        {achievements.map((a) => (
          <AchievementTile key={a.id} achievement={a} onClick={() => onOpenAchievement(a)} />
        ))}
      </div>
    </section>
  );
}

/** Feats of Strength section. */
function FeatsSection({ feats, onOpenAchievement }: { feats: readonly GameAchievement[]; onOpenAchievement: (a: GameAchievement) => void }) {
  if (feats.length === 0) return null;
  return (
    <section className="achievements-category">
      <h3 className="achievements-category-header">Feats of Strength · 0 pts</h3>
      <div className="achievements-grid">
        {feats.map((a) => (
          <AchievementTile key={a.id} achievement={a} onClick={() => onOpenAchievement(a)} />
        ))}
      </div>
    </section>
  );
}

/** Walking step milestones section. */
function WalkingSection({ milestones }: { milestones: GameStepMilestones | null }) {
  const view = formatStepMilestones(milestones);

  if (!view.available) {
    return (
      <section className="achievements-category">
        <h3 className="achievements-category-header">Walking</h3>
        <p className="muted">Steps unavailable.</p>
      </section>
    );
  }

  return (
    <section className="achievements-category">
      <h3 className="achievements-category-header">Walking</h3>
      {view.next && (
        <div className="achievements-next">
          <div className="achievements-next-header">
            <span>NEXT</span>
            <span>{view.next.name}</span>
          </div>
          <div className="achievements-progress-bar">
            <div className="achievements-progress-fill" style={{ width: `${view.next.percent}%` }} />
          </div>
          <div className="achievements-next-label">{view.next.label}</div>
        </div>
      )}
      {view.earned.length > 0 && (
        <div className="achievements-earned-list">
          <h4>EARNED</h4>
          <ul>
            {view.earned.map((m) => (
              <li key={m.id}>
                <span>{m.name}</span>
                <span className="achievements-earned-meta">
                  {m.points} pts · {shortDate(m.earnedDate, new Date().toISOString().slice(0, 10))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="achievements-footer muted small">
        Points only, no XP · no daily goal, no streak
      </p>
    </section>
  );
}

/** Achievement detail sheet. */
function AchievementDetail({
  achievement,
  totalPoints,
  pinned,
  onPin,
  onClose,
}: {
  achievement: GameAchievement;
  totalPoints: number;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const hidden = isHiddenUnearned(achievement);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="sheet-backdrop" role="presentation">
      <div ref={dialog} className="sheet achievement-detail" role="dialog" aria-modal="true" aria-label="Achievement detail" onKeyDown={onKeyDown}>
        <SheetHeader title="Achievement" onClose={onClose} backLabel="Achievements" onBack={onClose} />
        <div className="achievement-detail-content">
          <div className="achievement-detail-name">{displayName(achievement)}</div>
          <div className="achievement-detail-points">{displayPoints(achievement)} pts</div>
          {achievement.type === 'chain' && achievement.tier !== null && (
            <div className="achievement-detail-chain">Chain {achievement.tier + 1} of {achievement.tier + 2}</div>
          )}
          {achievement.earned && achievement.earnedDate && (
            <div className="achievement-detail-earned">
              Earned {shortDate(achievement.earnedDate, new Date().toISOString().slice(0, 10))}
            </div>
          )}
          {!achievement.earned && achievement.progress && (
            <div className="achievement-detail-progress">
              <div className="achievements-progress-bar">
                <div className="achievements-progress-fill" style={{ width: `${(achievement.progress.current / achievement.progress.target) * 100}%` }} />
              </div>
              <div>{progressText(achievement)}</div>
            </div>
          )}
          {!achievement.earned && achievement.locked && achievement.lockedReason && (
            <div className="achievement-detail-locked muted">{achievement.lockedReason}</div>
          )}
          <button type="button" className="achievement-pin-button" onClick={onPin}>
            {pinned ? 'Unpin' : 'Pin'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * GAM1-C Achievements page (plan screens 3-4). Groups achievements by category with counters and progress bars,
 * chains, meta, hidden ones shown as '???', Feats of Strength (0 points) and upcoming step milestones.
 */
export function Achievements({
  data,
  onBack,
  pinnedIds,
  onTogglePin,
}: {
  data: GameResponse;
  onBack: () => void;
  pinnedIds: readonly string[];
  onTogglePin: (id: string) => void;
}) {
  const [detailAchievement, setDetailAchievement] = useState<GameAchievement | null>(null);
  const groups = groupByCategory(data.character.achievements);
  const feats = data.character.feats;
  const points = totalPoints(data.character.achievements);
  const pinState = createPinState(pinnedIds);
  const isPinned = (id: string) => pinnedIds.includes(id);

  return (
    <>
      <div className="sheet-backdrop" role="presentation">
        <div className="sheet achievements-sheet" role="dialog" aria-modal="true" aria-label="Achievements">
          <SheetHeader title="Achievements" onClose={onBack} backLabel="Character" onBack={onBack} />
          <div className="achievements-content">
            <div className="achievements-total">{points} points</div>
            {groups.length === 0 && feats.length === 0 ? (
              <p className="muted">No achievements yet.</p>
            ) : (
              <>
                {groups.map((g) => (
                  <CategorySection
                    key={g.category}
                    category={g.category}
                    earned={g.earned}
                    total={g.total}
                    achievements={g.achievements}
                    onOpenAchievement={setDetailAchievement}
                  />
                ))}
                <FeatsSection feats={feats} onOpenAchievement={setDetailAchievement} />
                <WalkingSection milestones={data.stepMilestones} />
              </>
            )}
          </div>
        </div>
      </div>
      {detailAchievement && (
        <AchievementDetail
          achievement={detailAchievement}
          totalPoints={points}
          pinned={isPinned(detailAchievement.id)}
          onPin={() => {
            onTogglePin(detailAchievement.id);
            setDetailAchievement(null);
          }}
          onClose={() => setDetailAchievement(null)}
        />
      )}
    </>
  );
}