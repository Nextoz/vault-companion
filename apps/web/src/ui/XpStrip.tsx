import { useEffect, useRef, useState } from 'react';
import { stripFractions, stripMotion, type StripValue } from '../nav.ts';

/** A value the reward layer landed on the strip; `at` makes two identical landings distinct. */
export interface StripLanding {
  readonly value: StripValue;
  readonly at: number;
}

/**
 * D2: the 3 px XP strip along the top edge of the tab bar, like WoW's bar above the action bar. Fill = XP into the
 * level, then the rested reserve as a lighter run, and a tiny "zz" while rested. Decorative to assistive tech: the
 * Log tab carries the level as text. `read` is the shared /api/game read (CharacterRead); `landing` is the value a
 * "+XP" float delivered, which plays the reward motion and a brief gold glow.
 */
export function XpStrip({ read, landing }: { read: StripValue | null; landing: StripLanding | null }) {
  const [shown, setShown] = useState<StripValue | null>(read);
  const [motion, setMotion] = useState<'reward' | 'ui' | 'none'>('none');
  const [glow, setGlow] = useState(0);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // The newest of the two sources wins: a fresh read, or a landing after it.
  useEffect(() => {
    if (read === null) return;
    const prev = shownRef.current;
    if (prev && sameValue(prev, read)) return;
    setMotion(stripMotion(prev, read));
    setShown(read);
  }, [read]);
  useEffect(() => {
    if (landing === null) return;
    const prev = shownRef.current;
    if (!prev || !sameValue(prev, landing.value)) {
      setMotion(stripMotion(prev, landing.value) === 'none' ? 'none' : 'reward');
      setShown(landing.value);
    }
    setGlow((n) => n + 1);
  }, [landing]);

  if (shown === null) return null;
  const f = stripFractions(shown);
  return (
    <div className="xp-strip" aria-hidden="true" data-motion={motion} data-testid="xp-strip">
      <span className="xp-strip-fill" style={{ width: `${f.fill * 100}%` }} />
      {f.restedWidth > 0 && <span className="xp-strip-rested" style={{ left: `${f.restedStart * 100}%`, width: `${f.restedWidth * 100}%` }} />}
      {glow > 0 && <span key={glow} className="xp-strip-glow" style={{ width: `${f.fill * 100}%` }} />}
      {f.rested && <span className="xp-strip-zz">zz</span>}
    </div>
  );
}

function sameValue(a: StripValue, b: StripValue): boolean {
  return a.level === b.level && a.levelXp === b.levelXp && a.levelCost === b.levelCost && a.restedXp === b.restedXp;
}
