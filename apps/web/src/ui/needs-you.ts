// NY1: the "Needs you" sheet's rows - the things only the owner can decide. Pure: every row projects reads the
// Today card already holds, and its one action opens a screen or sheet the app already has (never a new command).
// A row that cannot name a reason is never emitted; an empty list hides the morning line.
import type { ScoutsResponse } from '@vault-companion/contracts';
import type { ActiveWorkItem, ActiveWorkRead } from '../active-work.ts';
import { displayState, pluralise, type DisplayState } from '../scouts.ts';
import { dateIn } from '../time.ts';

const ZONE = 'Europe/Copenhagen';

/** The one place a row opens: an existing tab, the Scouts tab's triage, or that item's existing edit sheet. */
export type NeedsYouTarget =
  | { readonly kind: 'scouts' }
  | { readonly kind: 'triage' }
  | { readonly kind: 'actions' }
  | { readonly kind: 'active-work'; readonly item: ActiveWorkItem; readonly revision: string };

export interface NeedsYouRow {
  /** Stable, unique React key. */
  readonly id: string;
  readonly title: string;
  /** Why the row is here, in the owner's words. */
  readonly why: string;
  readonly target: NeedsYouTarget;
}

/** The reads and counts the card holds; nothing is fetched to build a row. */
export interface NeedsYouFacts {
  readonly scouts: ScoutsResponse | null;
  /** The Tasks tab's own Active Work read, when it is already in hand; null before it loads. */
  readonly activeWork: ActiveWorkRead | null;
  readonly eventsToTriage: number;
  /** Queue items in the `attention` state (the Actions panel's predicate): refused, failed or unresolved. */
  readonly actionsNeedingAttention: number;
}

/** A failed or degraded scout is one the owner must look at; healthy, stale and absent states are not this line. */
const scoutProblem = (state: DisplayState): string | null =>
  state === 'Failed' ? 'Its last run failed' : state === 'Degraded' ? 'It ran with problems' : null;

/** `review` is a YYYY-MM-DD Copenhagen date; `dateIn` keeps the compare a calendar-date compare, never an instant. */
const reviewDate = (review: string): string => dateIn(`${review}T00:00:00Z`, ZONE);
const reviewDue = (review: string | null, today: string): boolean => review !== null && reviewDate(review) <= today;

/**
 * The sheet's rows in a fixed order: scouts (1), review-due Active Work (2), pending event decisions (3), then
 * Actions needing attention (4). Pure and total: missing data yields no row, never a guess.
 */
export function needsYou(facts: NeedsYouFacts, today: string): NeedsYouRow[] {
  const rows: NeedsYouRow[] = [];

  const scouts = facts.scouts;
  if (scouts) {
    for (const entry of scouts.scouts) {
      const status = entry.state === 'ok' ? entry.status : null;
      const why = scoutProblem(displayState(status, scouts.now));
      if (status === null || why === null) continue;
      rows.push({ id: `scouts:${entry.file}`, title: status.displayName, why, target: { kind: 'scouts' } });
    }
  }

  const activeWork = facts.activeWork;
  if (activeWork) {
    for (const item of activeWork.items) {
      if (!reviewDue(item.review, today)) continue;
      rows.push({
        id: `active-work:${item.locator.lineIndex}:${item.locator.lineText}`,
        title: item.name,
        why: item.review === today ? 'Review is due today' : `Review was due ${item.review}`,
        target: { kind: 'active-work', item, revision: activeWork.revision },
      });
    }
  }

  if (facts.eventsToTriage > 0) {
    rows.push({
      id: 'triage',
      title: 'Event triage',
      why: `${pluralise(facts.eventsToTriage, 'event decision')} waiting`,
      target: { kind: 'triage' },
    });
  }

  const actions = facts.actionsNeedingAttention;
  if (actions > 0) {
    rows.push({
      id: 'actions',
      title: 'Actions on this device',
      why: `${pluralise(actions, 'action')} ${actions === 1 ? 'needs' : 'need'} attention`,
      target: { kind: 'actions' },
    });
  }

  return rows;
}

/** The morning line's count text; the card renders no line at all when there are no rows. */
export function needsYouText(count: number): string {
  return `Needs you \u00b7 ${count}`;
}
