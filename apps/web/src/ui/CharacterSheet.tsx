import type { GameAchievement, GameProfession, GameRules } from '@vault-companion/contracts';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  howXpWorks, levelLabel, PROFESSION_DESTINATION, professionUnavailable, recentlyEarned,
  professionLine, restedSegment, skillPercent, unavailableLines, xpBar,
} from '../character.ts';
import { CharacterRead } from './CharacterRead.tsx';
import { SheetHeader } from './SheetHeader.tsx';
import { CopyNote } from './useLastCopy.tsx';

const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A profession ring: skill / cap as an arc. No animation, so reduced-motion is safe by construction. */
function SkillRing({ percent }: { percent: number }) {
  return <svg className="skill-ring" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <circle className="skill-ring-track" cx="24" cy="24" r={RADIUS} />
    <circle className="skill-ring-fill" cx="24" cy="24" r={RADIUS}
      strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
      transform="rotate(-90 24 24)" />
  </svg>;
}

function bar(levelXp: number, levelCost: number, restedXp: number) {
  const fill = xpBar(levelXp, levelCost);
  const rested = restedSegment(levelXp, levelCost, restedXp);
  return <span className="xp-bar" role="img" aria-label={levelLabel(levelXp, levelCost)}>
    <span className="xp-fill" style={{ width: `${fill.percent}%` }} />
    {rested.width > 0 && <span className="xp-rested" style={{ left: `${rested.start}%`, width: `${rested.width}%` }} />}
  </span>;
}

function ProfessionRow({ profession, rules, unavailable, onOpen }: {
  profession: GameProfession;
  rules: GameRules;
  unavailable: readonly string[];
  onOpen: (destination: string) => void;
}) {
  const note = professionUnavailable(profession.id, unavailable);
  const destination = PROFESSION_DESTINATION[profession.id];
  return <li className="character-profession" data-testid="character-profession">
    <button type="button" className="character-ring-button" aria-label={profession.name}
      onClick={() => destination !== undefined && onOpen(destination)}>
      <SkillRing percent={note === null ? skillPercent(profession.skill, rules.skill.max) : 0} />
    </button>
    <div className="character-profession-body">
      <p className="character-profession-name">{profession.name}</p>
      {note !== null
        ? <p className="muted small">{note}</p>
        : <p className="muted small">{professionLine(profession, rules)}</p>}
    </div>
  </li>;
}

function RecentAchievements({ achievements }: { achievements: readonly GameAchievement[] }) {
  const recent = recentlyEarned(achievements);
  if (recent.length === 0) return <p className="muted small">No achievements yet.</p>;
  return <ul className="character-achievements">
    {recent.map((a) => <li key={a.id} data-testid="character-achievement">
      <span>{a.name}</span> <span className="muted small">{a.earnedDate}</span>
    </li>)}
  </ul>;
}

function HowXpWorks({ rules }: { rules: GameRules }) {
  return <div className="character-how-xp">
    {howXpWorks(rules).map((section) => <section key={section.id}>
      <h3>{section.heading}</h3>
      <ul>{section.lines.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </section>)}
  </div>;
}

/**
 * GAM1-B Character screen: an overlay dialog (the card stays mounted behind it) so focus returns to the opener on
 * Close. Tapping a profession ring hands the destination to the App, which closes this and opens the Log view.
 */
export function CharacterSheet({ refreshKey, accountKey, onClose, onOpenProfession }: {
  refreshKey: number | null;
  accountKey: string | null;
  onClose: () => void;
  onOpenProfession: (destination: string) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<'overview' | 'how-xp'>('overview');
  useEffect(() => {
    const invoker = document.activeElement;
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => { if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus(); };
  }, []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      if (page === 'how-xp') setPage('overview');
      else onClose();
    }
    if (e.key !== 'Tab') return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
    const first = controls?.[0];
    const last = controls?.[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  return <div className="sheet-backdrop" role="presentation">
    <div ref={dialog} className="sheet character-sheet" role="dialog" aria-modal="true" aria-label="Character" onKeyDown={onKeyDown}>
      <CharacterRead refreshKey={refreshKey} accountKey={accountKey}>
        {({ view, data, retry }) => {
          if (page === 'how-xp') {
            return <>
              <button type="button" className="link back" onClick={() => setPage('overview')}>‹ Back</button>
              <h2>How XP works</h2>
              {data ? <HowXpWorks rules={data.rules} /> : <p className="muted">{view.res === null ? 'Loading…' : 'The rules could not be loaded.'}</p>}
            </>;
          }
          return <>
            <SheetHeader title="Character" onClose={onClose} />
            <CopyNote view={view} />
            {!data && <div className="character-card-empty">
              <p className="muted">{view.res === null ? 'Loading character…' : 'Character could not be loaded.'}</p>
              {view.res !== null && <button type="button" onClick={retry}>Retry</button>}
            </div>}
            {data && <>
              <div className="character-overall">
                <p className="character-overall-title">{data.character.title} · Level {data.character.level}</p>
                {bar(data.character.levelXp, data.character.levelCost, data.character.restedXp)}
                <p className="muted small">
                  {levelLabel(data.character.levelXp, data.character.levelCost)} · {data.character.points.total} points
                  {data.character.restedXp > 0 ? ` · ${data.character.restedXp} rested` : ''}
                </p>
              </div>
              {data.unavailable.length > 0 && <ul className="character-unavailable muted small">
                {unavailableLines(data.unavailable).map((line) => <li key={line}>{line}</li>)}
              </ul>}
              <ul className="character-professions">
                {data.character.professions.map((profession) => <ProfessionRow key={profession.id} profession={profession}
                  rules={data.rules} unavailable={data.unavailable} onOpen={onOpenProfession} />)}
              </ul>
              <section className="character-recent">
                <h3>Recent achievements</h3>
                <RecentAchievements achievements={data.character.achievements} />
              </section>
              <button type="button" className="character-how-link" onClick={() => setPage('how-xp')}>How XP works</button>
            </>}
          </>;
        }}
      </CharacterRead>
    </div>
  </div>;
}
