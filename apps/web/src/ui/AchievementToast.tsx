import type { GameAchievement } from '@vault-companion/contracts';
import { displayName, displayPoints } from '../achievements.ts';

/** Toast for individual achievement earned notification. */
export function AchievementToast({
  achievement,
  onDismiss,
}: {
  achievement: GameAchievement;
  onDismiss: () => void;
}) {
  return (
    <div className="achievement-toast" role="status">
      <div className="achievement-toast-content">
        <div className="achievement-toast-title">Achievement earned</div>
        <div className="achievement-toast-subtitle">
          {displayName(achievement)} · {displayPoints(achievement)} pts
        </div>
      </div>
      <button
        type="button"
        className="achievement-toast-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

/** Summary toast for first-run with multiple achievements. */
export function AchievementSummaryToast({
  count,
  firstYear,
  onDismiss,
}: {
  count: number;
  firstYear?: number;
  onDismiss: () => void;
}) {
  const yearText = firstYear ? ` since ${firstYear}` : '';
  return (
    <div className="achievement-toast" role="status">
      <div className="achievement-toast-content">
        <div className="achievement-toast-title">Achievement earned</div>
        <div className="achievement-toast-subtitle">
          {count} step milestone{count > 1 ? 's' : ''} earned{yearText}
        </div>
      </div>
      <button
        type="button"
        className="achievement-toast-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}