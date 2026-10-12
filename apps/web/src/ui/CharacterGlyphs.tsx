import type { ReactNode } from 'react';
import type { GlyphId } from '../character-skin.ts';

/**
 * Redesign R4: one glyph per achievement category and profession, drawn like the tab bar icons (24 grid, 1.8 stroke,
 * round caps and joins, currentColor), so the Character screens and the app chrome share one hand.
 */
const PATHS: Readonly<Record<GlyphId, ReactNode>> = {
  // A five-point star.
  general: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  // The Log tab's dumbbell.
  athletics: <path d="M4 9v6M20 9v6M7 7v10M17 7v10M7 12h10" />,
  // An open book.
  scholar: <><path d="M3 6.5c2.6-1.4 5.6-1.4 9 .7 3.4-2.1 6.4-2.1 9-.7V19c-2.6-1.4-5.6-1.4-9 .7-3.4-2.1-6.4-2.1-9-.7z" /><path d="M12 7.2v12.5" /></>,
  // A quill.
  lorekeeper: <><path d="M19.5 4.5C13 5 8.5 9.5 7 17c6-1 10.5-5.5 12.5-12.5z" /><path d="M4 20l3-3M11 13l3-3" /></>,
  // The Tasks tab's checklist.
  quartermaster: <><path d="m4 6 1.6 1.6L8.5 4.7M4 12.5l1.6 1.6 2.9-2.9M4 19l1.6 1.6 2.9-2.9" /><path d="M12 6.5h8M12 13h8M12 19.5h8" /></>,
  // A crown.
  feats: <><path d="M5 18 4 8l4.5 3.5L12 5l3.5 6.5L20 8l-1 10z" /><path d="M5 21h14" /></>,
  // Two footprints.
  journey: <><ellipse cx="8.5" cy="8" rx="2.8" ry="4.3" /><ellipse cx="15.5" cy="15.5" rx="2.8" ry="4.3" /></>,
};

export function Glyph({ id, className }: { id: GlyphId; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {PATHS[id]}
  </svg>;
}

/**
 * The framed glyph of an achievement (48 px in the grid). Earned: lit in its quality colour (CSS reads
 * `data-quality` on an ancestor). Locked: grey, with the progress arc (`arc`, 0..1) around the glyph when it has
 * measurable progress. Hidden: a single "?" in the frame.
 */
export function Medal({ glyph, lit, arc = null, hidden = false, className = '' }: {
  glyph: GlyphId;
  lit: boolean;
  arc?: number | null;
  hidden?: boolean;
  className?: string;
}) {
  return <span className={`skin-medal skin-frame${lit ? ' is-lit' : ''}${className === '' ? '' : ` ${className}`}`} aria-hidden="true">
    {hidden
      ? <span className="skin-medal-unknown">?</span>
      : <>
        {arc !== null && <svg className="skin-medal-arc" viewBox="0 0 48 48" focusable="false">
          <circle className="skin-medal-track" cx="24" cy="24" r="18" />
          {arc > 0 && <circle className="skin-medal-fill" cx="24" cy="24" r="18" pathLength={100}
            strokeDasharray={`${Math.round(arc * 100)} 100`} transform="rotate(-90 24 24)" />}
        </svg>}
        <Glyph id={glyph} className="skin-medal-glyph" />
      </>}
  </span>;
}
