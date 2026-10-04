import { ScoutsResponse, type ScoutStatus } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import type { ActiveWorkRead } from '../active-work.ts';
import { liveDismissals, needsYou, needsYouText, sameDismissals, type NeedsYouFacts, type NeedsYouRow } from './needs-you.ts';

const REV = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);

const scout = (file: string, runStatus: ScoutStatus['runStatus'], displayName = 'City events', lastError: string | null = null): ScoutsResponse['scouts'][number] => ({
  state: 'ok',
  file,
  status: {
    schemaVersion: 1, scoutId: file.replace('.json', ''), displayName, schedule: null, expectedEveryHours: 24,
    lastAttemptAt: '2026-10-02T09:00:00Z', lastSuccessAt: '2026-10-02T09:00:00Z', runStatus,
    sources: null, aiHealth: null, findings: 0, added: null, errors: null, lastError, latestOutput: null, history: [],
  },
});
const scouts = (...entries: ScoutsResponse['scouts']): ScoutsResponse =>
  ScoutsResponse.parse({ revision: REV, now: '2026-10-02T10:00:00Z', scouts: entries });

const locator = { path: 'Tasks/Active Work Now.md' as const, blobSha: BLOB, lineIndex: 3, lineText: '- [ ] **Garden:** Next: order seeds', occurrencesAtRead: 1 };
const activeWork = (review: string | null, name = 'Garden'): ActiveWorkRead => ({
  status: 'ok', revision: REV, blobSha: BLOB, markdown: '## Now',
  items: [{ locator, name, outcome: null, next: null, review, link: null, needsReview: false }],
  unknownNowLines: [], today: '2026-10-03',
});

const facts = (over: Partial<NeedsYouFacts> = {}): NeedsYouFacts =>
  ({ scouts: null, activeWork: null, eventsToTriage: 0, actionsNeedingAttention: 0, dismissedScouts: {}, ...over });
const kinds = (rows: readonly NeedsYouRow[]) => rows.map((row) => row.target.kind);

describe('needsYou', () => {
  it('returns no rows when nothing needs the owner', () => {
    expect(needsYou(facts(), '2026-10-03')).toEqual([]);
  });

  it('lists a failed scout with its own error text, never degraded or healthy ones', () => {
    const rows = needsYou(facts({
      scouts: scouts(
        scout('city.json', 'failed', 'City events', 'runner could not start'),
        scout('garden.json', 'degraded', 'Garden scout', 'one source timed out'),
        scout('ok.json', 'success', 'Healthy'),
      ),
    }), '2026-10-03');
    expect(rows.map((row) => [row.title, row.why])).toEqual([['City events', 'runner could not start']]);
    expect(kinds(rows)).toEqual(['scouts']);
  });

  it('falls back to a plain sentence when a failed run leaves no error text', () => {
    const rows = needsYou(facts({ scouts: scouts(scout('city.json', 'failed', 'City events', '   ')) }), '2026-10-03');
    expect(rows.map((row) => row.why)).toEqual(['Its last run failed']);
  });

  it('hides a scout row only while the dismissed error text persists', () => {
    const current = scouts(scout('city.json', 'failed', 'City events', 'runner could not start'));
    const same = needsYou(facts({ scouts: current, dismissedScouts: { 'scouts:city.json': 'runner could not start' } }), '2026-10-03');
    expect(same).toEqual([]);
    const changed = needsYou(facts({ scouts: current, dismissedScouts: { 'scouts:city.json': 'an older error' } }), '2026-10-03');
    expect(changed.map((row) => row.why)).toEqual(['runner could not start']);
  });

  it('never lets a stored scout dismissal hide triage or actions rows', () => {
    const rows = needsYou(facts({
      eventsToTriage: 1, actionsNeedingAttention: 1,
      dismissedScouts: { triage: 'x', actions: 'y', 'scouts:city.json': 'runner could not start' },
    }), '2026-10-03');
    expect(kinds(rows)).toEqual(['triage', 'actions']);
  });

  it('lists Active Work due today or earlier, never tomorrow or an undated item', () => {
    const [due] = needsYou(facts({ activeWork: activeWork('2026-10-03') }), '2026-10-03');
    expect(due).toMatchObject({ title: 'Garden', why: 'Review is due today', target: { kind: 'active-work', revision: REV } });
    expect(needsYou(facts({ activeWork: activeWork('2026-10-02') }), '2026-10-03')[0]?.why).toBe('Review was due 2026-10-02');
    expect(needsYou(facts({ activeWork: activeWork('2026-10-04') }), '2026-10-03')).toEqual([]);
    expect(needsYou(facts({ activeWork: activeWork(null) }), '2026-10-03')).toEqual([]);
  });

  it('lists pending event decisions and actions needing attention with their counts', () => {
    const rows = needsYou(facts({ eventsToTriage: 2, actionsNeedingAttention: 1 }), '2026-10-03');
    expect(rows.map((row) => [row.target.kind, row.why])).toEqual([
      ['triage', '2 event decisions waiting'],
      ['actions', '1 action needs attention'],
    ]);
    expect(needsYou(facts({ actionsNeedingAttention: 3 }), '2026-10-03')[0]?.why).toBe('3 actions need attention');
  });

  it('keeps the fixed order scouts, Active Work, triage, actions', () => {
    const rows = needsYou(facts({
      scouts: scouts(scout('city.json', 'failed')), activeWork: activeWork('2026-10-03'), eventsToTriage: 1, actionsNeedingAttention: 2,
    }), '2026-10-03');
    expect(kinds(rows)).toEqual(['scouts', 'active-work', 'triage', 'actions']);
  });

  it('drops a stored dismissal once its scout recovers or its text changes', () => {
    const dismissed = { 'scouts:city.json': 'runner could not start' };
    expect(liveDismissals(dismissed, scouts(scout('city.json', 'failed', 'City events', 'runner could not start')))).toEqual(dismissed);
    expect(liveDismissals(dismissed, scouts(scout('city.json', 'success', 'City events', 'runner could not start')))).toEqual({});
    expect(liveDismissals(dismissed, scouts(scout('city.json', 'failed', 'City events', 'a new error')))).toEqual({});
    expect(sameDismissals(dismissed, { 'scouts:city.json': 'runner could not start' })).toBe(true);
    expect(sameDismissals(dismissed, {})).toBe(false);
    expect(sameDismissals(dismissed, { 'scouts:city.json': 'other' })).toBe(false);
  });

  it('words the morning line for its count', () => {
    expect(needsYouText(3)).toBe('Needs you \u00b7 3');
  });
});
