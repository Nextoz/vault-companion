import { emptyCharacterLine, levelLabel, restedSegment, xpBar } from '../character.ts';
import { CharacterRead } from './CharacterRead.tsx';
import { CopyNote } from './useLastCopy.tsx';

/** GAM1-B: the Log area's Character card. A plain card (not a fifth Log tab) so the 390px segmented switch stays roomy. */
export function CharacterCard({ refreshKey, accountKey, onOpen }: {
  refreshKey: number | null;
  accountKey: string | null;
  onOpen: () => void;
}) {
  return <section className="group character-card" aria-label="Character">
    <CharacterRead refreshKey={refreshKey} accountKey={accountKey}>
      {({ view, data, retry }) => {
        const label = data ? levelLabel(data.character.levelXp, data.character.levelCost) : '';
        const bar = data ? xpBar(data.character.levelXp, data.character.levelCost) : null;
        const rested = data ? restedSegment(data.character.levelXp, data.character.levelCost, data.character.restedXp) : null;
        const empty = data ? emptyCharacterLine(data.character) : null;
        return <>
          <CopyNote view={view} />
          {!data && <div className="character-card-empty">
            <p className="muted">{view.res === null ? 'Loading character…' : 'Character could not be loaded.'}</p>
            {view.res !== null && <button type="button" onClick={retry}>Retry</button>}
          </div>}
          {data && <button type="button" className="character-card-button" onClick={onOpen} aria-label="Open Character">
            <span className="character-card-head">
              <strong className="character-card-title">{data.character.title}</strong>
              <span className="muted small">Level {data.character.level}</span>
            </span>
            <span className="xp-bar" role="img" aria-label={label}>
              <span className="xp-fill" style={{ width: `${bar!.percent}%` }} />
              {rested!.width > 0 && <span className="xp-rested" style={{ left: `${rested!.start}%`, width: `${rested!.width}%` }} />}
            </span>
            <span className="character-card-foot">
              <span className="small">{label}</span>
              <span className="muted small">{data.character.points.total} points</span>
            </span>
            {empty !== null && <span className="muted small">{empty}</span>}
          </button>}
        </>;
      }}
    </CharacterRead>
  </section>;
}
