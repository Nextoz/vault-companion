import { ScoutsResponse, type ScoutStatus } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import type { ActiveWorkRead } from '../active-work.ts';
import { needsYou, needsYouText, type NeedsYouFacts, type NeedsYouRow } from './needs-you.ts';

const REV = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);

const scout = (file: string, runStatus: ScoutStatus['runStatus'], displayName = 'City events'): ScoutsResponse['scouts'][number] => ({
  state: 'ok',
  file,
  status: {
    schemaVersion: 1, scoutId: file.replace('.json', ''), displayName, schedule: null, expectedEveryHours: 24,
    lastAttemptAt: '2026-10-02T09:00:00Z', lastSuccessAt: '2026-10-02T09:00:00Z', runStatus,
    sources: null, aiHealth: null, findings: 0, added: null, errors: null, lastError: null, latestOutput: null, history: [],
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
  ({ scouts: null, activeWork: null, eventsToTriage: 0, actionsNeedingAttention: 0, ...over });
const kinds = (rows: readonly NeedsYouRow[]) => rows.map((row) => row.target.kind);

describe('needsYou', () => {
  it('returns no rows when nothing needs the owner', () => {
    expect(needsYou(facts(), '2026-10-03')).toEqual([]);
  });

  it('lists failed and degraded scouts, never healthy ones', () => {
    const rows = needsYou(facts({
      scouts: scouts(scout('city.json', 'failed'), scout('garden.json', 'degraded', 'Garden scout'), scout('ok.json', 'success', 'Healthy')),
    }), '2026-10-03');
    expect(rows.map((row) => [row.title, row.why])).toEqual([
      ['City events', 'Its last run failed'],
      ['Garden scout', 'It ran with problems'],
    ]);
    expect(kinds(rows)).toEqual(['scouts', 'scouts']);
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

  it('words the morning line for its count', () => {
    expect(needsYouText(3)).toBe('Needs you \u00b7 3');
  });
});
