import type { GameAchievement, GameCharacter, GameProfession, GameResponse, GameRules } from '@vault-companion/contracts';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  howXpWorks, levelLabel, PROFESSION_DESTINATION, professionUnavailable, recentlyEarned,
  restedSegment, shortDate, skillPercent, trackedAchievements, unavailableLines, xpBar,
} from '../character.ts';
import { displayName, displayPoints, PIN_LIMIT, pinnedKey, resolveTracked } from '../achievements.ts';
import { achievementQuality, categoryGlyph } from '../character-skin.ts';
import { setSoundEnabled, soundEnabled } from '../sound.ts';
import { AchievementsPage } from './Achievements.tsx';
import { Glyph, Medal } from './CharacterGlyphs.tsx';
import './CharacterSkin.css';
import { CharacterRead } from './CharacterRead.tsx';
import { SheetHeader } from './SheetHeader.tsx';
import { CopyNote } from './useLastCopy.tsx';

/** Pinned ids are optional device state, scoped by account; every read and write is guarded. */
function readPinned(account: string | null): readonly string[] {
  try {
    const raw = localStorage.getItem(pinnedKey(account));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writePinned(account: string | null, ids: readonly string[]): void {
  try {
    localStorage.setItem(pinnedKey(account), JSON.stringify(ids));
  } catch {
    // Storage unavailable: pins still work for this session.
  }
}

/**
 * An arc ring: `percent` of the circle from 12 o'clock, plus an optional second arc (the rested reserve) starting
 * where the fill ends. Static, so reduced motion is safe by construction. pathLength=100 keeps the dash maths in %.
 */
function Ring({ size, stroke, percent, extra = null, className }: {
  size: number;
  stroke: number;
  percent: number;
  extra?: { start: number; width: number } | null;
  className: string;
}) {
  const r = (size - stroke) / 2;
  const c = size / 2;
  return <svg className={className} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
    <circle className="ring-track" cx={c} cy={c} r={r} strokeWidth={stroke} />
    {extra !== null && extra.width > 0 && <circle className="ring-rested" cx={c} cy={c} r={r} strokeWidth={stroke}
      pathLength={100} strokeDasharray={`${extra.width} 100`} strokeDashoffset={-extra.start} transform={`rotate(-90 ${c} ${c})`} />}
    {percent > 0 && <circle className="ring-fill" cx={c} cy={c} r={r} strokeWidth={stroke}
      pathLength={100} strokeDasharray={`${percent} 100`} transform={`rotate(-90 ${c} ${c})`} />}
  </svg>;
}

function LevelHero({ character }: { character: GameCharacter }) {
  const fill = xpBar(character.levelXp, character.levelCost);
  const rested = restedSegment(character.levelXp, character.levelCost, character.restedXp);
  return <div className="character-hero">
    <div className="character-level" role="img"
      aria-label={`Level ${character.level}, ${levelLabel(character.levelXp, character.levelCost)}${character.restedXp > 0 ? `, ${character.restedXp} rested` : ''}`}>
      <Ring className="level-ring" size={136} stroke={10} percent={fill.percent} extra={rested} />
      <span className="character-level-number">{character.level}</span>
      <span className="character-level-word">Level</span>
    </div>
    <p className="character-title">{character.title}</p>
    <p className="character-xp-line">
      <span>{levelLabel(character.levelXp, character.levelCost)}</span>
      {character.restedXp > 0 && <span className="character-rested">+{character.restedXp} rested</span>}
      <span>{character.points.total} points</span>
    </p>
  </div>;
}

function ProfessionRing({ profession, rules, unavailable, onOpen }: {
  profession: GameProfession;
  rules: GameRules;
  unavailable: readonly string[];
  onOpen: (destination: string) => void;
}) {
  const note = professionUnavailable(profession.id, unavailable);
  const destination = PROFESSION_DESTINATION[profession.id];
  const label = note === null
    ? `${profession.name}: ${profession.rank}, skill ${profession.skill} of ${rules.skill.max}, ${profession.xp} XP`
    : `${profession.name}: ${note}`;
  return <li className="character-profession" data-testid="character-profession" data-profession={profession.id}>
    <button type="button" className="character-ring-button" aria-label={label}
      onClick={() => destination !== undefined && onOpen(destination)}>
      <span className="character-ring">
        <Ring className="skill-ring" size={64} stroke={6} percent={note === null ? skillPercent(profession.skill, rules.skill.max) : 0} />
        <Glyph id={categoryGlyph(profession.id)} className="character-ring-glyph" />
      </span>
      <span className="character-profession-name" aria-hidden="true">{profession.name}</span>
      <span className="character-profession-rank" aria-hidden="true">{note ?? profession.rank}</span>
      <span className="character-profession-unit" aria-hidden="true">{note === null ? `${profession.skill} / ${rules.skill.max}` : '–'}</span>
    </button>
  </li>;
}

function Tracked({ achievements, pinnedIds }: { achievements: readonly GameAchievement[]; pinnedIds: readonly string[] }) {
  const pinned = resolveTracked(pinnedIds, achievements, PIN_LIMIT);
  if (pinned.length > 0) {
    return <section className="character-section">
      <h3>Tracked</h3>
      <ul className="character-rows skin-frame">
        {pinned.map((a) => <li key={a.id} className="character-tracked" data-testid="character-tracked">
          <span className="character-row-line"><span>{displayName(a)}</span><span className="character-row-meta">{displayPoints(a)} pts</span></span>
          {a.progress !== null && a.progress.target > 0 && <span className="character-progress" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (a.progress.current / a.progress.target) * 100)}%` }} />
          </span>}
        </li>)}
      </ul>
    </section>;
  }
  const tracked = trackedAchievements(achievements);
  if (tracked.length === 0) return null;
  return <section className="character-section">
    <h3>Tracked</h3>
    <ul className="character-rows skin-frame">
      {tracked.map((t) => <li key={t.id} className="character-tracked" data-testid="character-tracked">
        <span className="character-row-line"><span>{t.name}</span><span className="character-row-meta">{t.current} / {t.target}</span></span>
        <span className="character-progress" aria-hidden="true"><span style={{ width: `${t.percent}%` }} /></span>
      </li>)}
    </ul>
  </section>;
}

function RecentAchievements({ achievements, today }: { achievements: readonly GameAchievement[]; today: string }) {
  const recent = recentlyEarned(achievements);
  return <section className="character-section">
    <h3>Recent achievements</h3>
    {recent.length === 0
      ? <p className="muted small">No achievements yet.</p>
      : <ul className="character-rows skin-frame">
        {recent.map((a) => <li key={a.id} className="character-row-line character-recent" data-testid="character-achievement" data-quality={achievementQuality(a)}>
          <Medal glyph={categoryGlyph(a.category)} lit className="is-small" />
          <span className="character-recent-name">{a.name}</span>
          <span className="character-row-meta">{a.points} pts · {shortDate(a.earnedDate ?? '', today)}</span>
        </li>)}
      </ul>}
  </section>;
}

function HowXpWorks({ rules, critical }: { rules: GameRules; critical: NonNullable<GameResponse['feedback']>['critical'] | null }) {
  return <div className="character-how-xp">
    {howXpWorks(rules).map((section) => <section key={section.id} className="character-section">
      <h3>{section.heading}</h3>
      {section.lines.map((line, i) => <p key={i}>{line}</p>)}
    </section>)}
    {critical !== null && critical.every > 0 && <section className="character-section" data-testid="how-xp-critical">
      <h3>Critical!</h3>
      <p>About 1 in {critical.every} rewarded actions is a Critical!: {critical.multiplier}× its base XP. Daily caps still apply.</p>
    </section>}
  </div>;
}

/** ADR-0064: the reward sound switch. Device-held, on by default; the iPhone silent switch also silences it. */
function SoundToggle() {
  const [on, setOn] = useState(soundEnabled);
  return <button type="button" className="character-link-row" role="switch" aria-checked={on}
    onClick={() => { const next = !on; setSoundEnabled(next); setOn(next); }}>
    Reward sounds<span className="character-row-meta">{on ? 'On' : 'Off'}</span>
  </button>;
}

/**
 * GAM1-B Character screen (plan screen 2, mockup 2026-10-10): the level ring, the four profession rings in their own
 * colours, tracked progress and recent achievements. An overlay dialog (the card stays mounted behind it) so focus
 * returns to the opener on Close. Tapping a ring hands the destination to the App, which opens that Log view.
 */
export function CharacterSheet({ refreshKey, accountKey, onClose, onOpenProfession }: {
  refreshKey: number | null;
  accountKey: string | null;
  onClose: () => void;
  onOpenProfession: (destination: string) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<'overview' | 'how-xp' | 'achievements'>('overview');
  const [pinnedIds, setPinnedIds] = useState<readonly string[]>(() => readPinned(accountKey));
  useEffect(() => { setPinnedIds(readPinned(accountKey)); }, [accountKey]);
  const changePins = (next: readonly string[]) => { setPinnedIds(next); writePinned(accountKey, next); };
  // Return focus to the opener when the sheet closes (the card stays mounted behind the overlay).
  useEffect(() => {
    const invoker = document.activeElement;
    return () => { if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus(); };
  }, []);
  // Move focus into the dialog on open and again on every overview <-> how-xp toggle, where the controls differ;
  // each page starts at the top.
  useEffect(() => {
    dialog.current?.scrollTo({ top: 0 });
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus({ preventScroll: true });
  }, [page]);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      if (page === 'overview') onClose();
      else setPage('overview');
    }
    if (e.key !== 'Tab') return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
    const first = controls?.[0];
    const last = controls?.[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  return <div className="sheet-backdrop" role="presentation">
    <div ref={dialog} className="sheet character-sheet character-skin" role="dialog" aria-modal="true" aria-label="Character" onKeyDown={onKeyDown}>
      <CharacterRead refreshKey={refreshKey} accountKey={accountKey}>
        {({ view, data, retry }) => {
          if (page === 'achievements') {
            return <AchievementsPage data={data} view={view} retry={retry} onBack={() => setPage('overview')} pinnedIds={pinnedIds} onPinsChange={changePins} />;
          }
          if (page === 'how-xp') {
            return <>
              <SheetHeader title="How XP works" onClose={onClose} onBack={() => setPage('overview')} backLabel="Character" />
              {data ? <HowXpWorks rules={data.rules} critical={data.feedback?.critical ?? null} /> : <p className="muted">{view.res === null ? 'Loading…' : 'The rules could not be loaded.'}</p>}
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
              <section className="character-pane skin-frame" aria-label="Level and professions">
                <LevelHero character={data.character} />
                {data.unavailable.length > 0 && <ul className="character-unavailable">
                  {unavailableLines(data.unavailable).map((line) => <li key={line}>{line}</li>)}
                </ul>}
                <ul className="character-professions" aria-label="Professions">
                  {data.character.professions.map((profession) => <ProfessionRing key={profession.id} profession={profession}
                    rules={data.rules} unavailable={data.unavailable} onOpen={onOpenProfession} />)}
                </ul>
                <p className="character-hint">Tap a ring to open its log</p>
              </section>
              <Tracked achievements={data.character.achievements} pinnedIds={pinnedIds} />
              <RecentAchievements achievements={data.character.achievements} today={data.now.slice(0, 10)} />
              <div className="character-links skin-frame">
                <button type="button" className="character-link-row" onClick={() => setPage('achievements')}>
                  All achievements<span className="character-chevron" aria-hidden="true">›</span>
                </button>
                <button type="button" className="character-link-row" onClick={() => setPage('how-xp')}>
                  How XP works<span className="character-chevron" aria-hidden="true">›</span>
                </button>
                <SoundToggle />
              </div>
            </>}
          </>;
        }}
      </CharacterRead>
    </div>
  </div>;
}
