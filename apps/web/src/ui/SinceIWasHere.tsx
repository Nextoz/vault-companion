// SIWH: the closable pane at the top of Today. It reads the snapshot the device kept under `vc.sinceIWasHere`
// (localStorage, via prefs), shows at most five lines for sources that moved up since the owner last looked, and
// renders nothing at all when there is nothing to say. Closing or "Dismiss all" stores the current counts/keys, so
// the pane stays closed until something newer arrives. It never changes any underlying item.
// UX8: the pane now collapses to one summary line that expands to the changes and the dismiss controls.
import { useEffect, useState } from 'react';
import { prefs } from '../prefs.ts';
import {
  establishBaseline,
  sameSnapshot,
  sinceIWasHereLines,
  snapshotOf,
  type SiwhFacts,
  type SiwhSnapshot,
  type SiwhTarget,
} from './since-i-was-here.ts';

export interface SinceIWasHereProps {
  readonly facts: SiwhFacts;
  readonly onOpen: (target: SiwhTarget) => void;
}

export function SinceIWasHere({ facts, onOpen }: SinceIWasHereProps) {
  const [snapshot, setSnapshot] = useState<SiwhSnapshot | null>(() => prefs.sinceIWasHereSnapshot());
  const [expanded, setExpanded] = useState(false);

  // First install and a source the device has never observed: record the baseline, never announce it. A source
  // already in the snapshot is left untouched, so a render alone never advances what the owner has already seen.
  useEffect(() => {
    const merged = establishBaseline(snapshot, facts, Date.now());
    if (sameSnapshot(snapshot, merged)) return;
    prefs.setSinceIWasHereSnapshot(merged);
    setSnapshot(merged);
  }, [snapshot, facts]);

  const lines = sinceIWasHereLines(facts, snapshot);
  if (lines.length === 0) return null;

  const dismiss = () => {
    const next = snapshotOf(facts, snapshot, Date.now());
    prefs.setSinceIWasHereSnapshot(next);
    setSnapshot(next);
    setExpanded(false);
  };

  return (
    <section className="group since-i-was-here" aria-label="Since I was here">
      <button type="button" className="siwh-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        Since I was here · {lines.length === 1 ? '1 change' : `${lines.length} changes`}
      </button>
      {expanded && (
        <>
          {lines.map((line) => (
            <button key={line.id} type="button" className="siwh-line" onClick={() => onOpen(line.target)}>{line.text}</button>
          ))}
          <div className="siwh-actions">
            <button type="button" className="link siwh-dismiss" onClick={dismiss}>Dismiss all</button>
            <button type="button" className="link siwh-close" aria-label="Close since I was here" onClick={dismiss}>{'\u00d7'}</button>
          </div>
        </>
      )}
    </section>
  );
}
