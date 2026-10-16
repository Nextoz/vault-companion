import { emptyCharacterLine, levelLabel, restedSegment, xpBar } from '../character.ts';
import { CharacterRead } from './CharacterRead.tsx';
import { CopyNote } from './useLastCopy.tsx';

/**
 * GAM1-B, R3b (review #9): the Log area's way into Character, collapsed to one 56 px strip so the Log opens on its
 * content: a level badge, the title over a thin XP bar with its rested run, the points, and a chevron. The whole strip
 * is the button; it opens the Character screen.
 */
export function CharacterCard({ refreshKey, accountKey, onOpen }: {
  refreshKey: number | null;
  accountKey: string | null;
  onOpen: () => void;
}) {
  return <section className="character-card" aria-label="Character">
    <CharacterRead refreshKey={refreshKey} accountKey={accountKey}>
      {({ view, data, retry }) => {
        if (!data) {
          return <>
            <CopyNote view={view} />
            <div className="character-card-empty">
              <p className="muted small">{view.res === null ? 'Loading character…' : 'Character could not be loaded.'}</p>
              {view.res !== null && <button type="button" className="link" onClick={retry}>Retry</button>}
            </div>
          </>;
        }
        const { character } = data;
        const label = levelLabel(character.levelXp, character.levelCost);
        const bar = xpBar(character.levelXp, character.levelCost);
        const rested = restedSegment(character.levelXp, character.levelCost, character.restedXp);
        const empty = emptyCharacterLine(character);
        return <>
          <CopyNote view={view} />
          <button type="button" className="character-card-button" onClick={onOpen}
            aria-label={`Open Character: ${character.title}, level ${character.level}, ${label}, ${character.points.total} points`}>
            <span className="character-card-level" aria-hidden="true">{character.level}</span>
            <span className="character-card-main">
              <span className="character-card-head">
                <span className="character-card-title">{character.title}</span>
                <span className="character-card-xp">{label}</span>
              </span>
              <span className="xp-bar" aria-hidden="true">
                <span className="xp-fill" style={{ width: `${bar.percent}%` }} />
                {rested.width > 0 && <span className="xp-rested" style={{ left: `${rested.start}%`, width: `${rested.width}%` }} />}
              </span>
            </span>
            <span className="character-card-points">{character.points.total}<span className="character-card-unit"> pts</span></span>
            <span className="character-card-chevron" aria-hidden="true">{'›'}</span>
          </button>
          {empty !== null && <p className="muted small character-card-note">{empty}</p>}
        </>;
      }}
    </CharacterRead>
  </section>;
}
